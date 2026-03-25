'use strict';

const logger = require('../config/logger');

/**
 * Advanced Load Shedding & Backpressure Middleware
 * 
 * Production-grade request lifecycle management:
 *   - Event loop lag monitoring (500ms sampling)
 *   - Dynamic concurrency limits (adapts to current load)
 *   - Historical metrics (60 samples for admin graphs)
 *   - Redis circuit breaker (skip Redis under extreme load)
 *   - Request timeout with auto-abort
 *   - Error recording for admin panel
 */

// ═══════════════════════════════════════
// METRICS STATE
// ═══════════════════════════════════════
const metrics = {
  eventLoopLag: 0,
  activeRequests: 0,
  totalRequests: 0,
  rejectedRequests: 0,
  timedOutRequests: 0,
  requestsPerSecond: 0,
  errors: [],                 // last 100 errors for admin panel
  dynamicMaxRequests: 150,    // adaptive — starts at 150, adjusts based on load
};

// Historical samples (last 60 = ~5 minutes at 5s intervals)
const history = {
  eventLoopLag: [],
  rps: [],
  memory: [],
  activeRequests: [],
  timestamps: [],
};
const MAX_HISTORY = 60;

// ═══════════════════════════════════════
// THRESHOLDS (tuned for single-instance Node.js)
// ═══════════════════════════════════════
const THRESHOLDS = {
  // Event loop lag
  warnLag: 100,          // ms — log warning
  shedLag: 150,          // ms — shed non-critical requests
  criticalLag: 300,      // ms — shed ALL except health endpoints

  // Request limits
  baseMaxRequests: 150,  // starting point for dynamic limit
  minMaxRequests: 50,    // never go below this
  maxMaxRequests: 250,   // never go above this

  // Timeouts
  requestTimeoutMs: 12000, // 12s — tighter than before

  // Redis circuit breaker
  redisCircuitLag: 200,  // ms — skip non-critical Redis ops when lag exceeds this
};

// ═══════════════════════════════════════
// CRITICAL PATHS (never shed)
// ═══════════════════════════════════════
const CRITICAL_PATHS = [
  '/',
  '/auth/sync-user',
  '/admin/system/health',
  '/admin/system/logs',
];

function isCriticalPath(url) {
  return CRITICAL_PATHS.some(p => url.startsWith(p));
}

// ═══════════════════════════════════════
// EVENT LOOP LAG MONITOR
// ═══════════════════════════════════════
let lagInterval = null;
let lastCheck = process.hrtime.bigint();

function startLagMonitor() {
  if (lagInterval) return;

  lagInterval = setInterval(() => {
    const now = process.hrtime.bigint();
    const expected = 500n * 1000000n; // 500ms in ns
    const actual = now - lastCheck;
    const lagNs = actual - expected;

    metrics.eventLoopLag = Math.max(0, Number(lagNs) / 1_000_000);
    lastCheck = now;

    // Adjust dynamic concurrency limit based on current lag
    adjustDynamicLimit();
  }, 500);

  lagInterval.unref();
}

// ═══════════════════════════════════════
// DYNAMIC CONCURRENCY ADJUSTMENT
// ═══════════════════════════════════════
function adjustDynamicLimit() {
  const lag = metrics.eventLoopLag;
  let newLimit = metrics.dynamicMaxRequests;

  if (lag > THRESHOLDS.criticalLag) {
    // Critical: aggressively reduce
    newLimit = Math.max(THRESHOLDS.minMaxRequests, Math.floor(newLimit * 0.7));
  } else if (lag > THRESHOLDS.shedLag) {
    // High: reduce gradually
    newLimit = Math.max(THRESHOLDS.minMaxRequests, newLimit - 10);
  } else if (lag < 50 && metrics.activeRequests < newLimit * 0.5) {
    // Low load: recover gradually
    newLimit = Math.min(THRESHOLDS.maxMaxRequests, newLimit + 5);
  }

  metrics.dynamicMaxRequests = newLimit;
}

// ═══════════════════════════════════════
// REQUESTS PER SECOND COUNTER
// ═══════════════════════════════════════
let rpsCount = 0;
let rpsInterval = null;

function startRpsCounter() {
  if (rpsInterval) return;

  rpsInterval = setInterval(() => {
    metrics.requestsPerSecond = rpsCount;
    rpsCount = 0;
  }, 1000);

  rpsInterval.unref();
}

// ═══════════════════════════════════════
// HISTORICAL METRICS RECORDER (In-Memory)
// ═══════════════════════════════════════
let historyInterval = null;

function startHistoryRecorder() {
  if (historyInterval) return;

  historyInterval = setInterval(() => {
    const memUsage = process.memoryUsage();

    history.eventLoopLag.push(Math.round(metrics.eventLoopLag));
    history.rps.push(metrics.requestsPerSecond);
    history.memory.push(Math.round(memUsage.rss / 1024 / 1024));
    history.activeRequests.push(metrics.activeRequests);
    history.timestamps.push(new Date().toISOString());

    // Trim to max
    for (const key of Object.keys(history)) {
      if (history[key].length > MAX_HISTORY) {
        history[key] = history[key].slice(-MAX_HISTORY);
      }
    }
  }, 5000); // Every 5 seconds

  historyInterval.unref();
}

// ═══════════════════════════════════════
// IN-MEMORY LONG-TERM RECORDERS
// ═══════════════════════════════════════
const longTerm = {
  traffic1h: [],
  serverLoad24h: []
};

function startInMemoryRecorders() {
  // 1-hour traffic metrics every 1 minute
  setInterval(() => {
    longTerm.traffic1h.push({
      t: new Date().toISOString(),
      rps: metrics.requestsPerSecond,
      active: metrics.activeRequests,
      lag: Math.round(metrics.eventLoopLag),
    });
    // Keep exactly 60 points
    if (longTerm.traffic1h.length > 60) {
      longTerm.traffic1h.shift();
    }
  }, 60000).unref();

  // 24-hour load metrics every 10 minutes
  setInterval(() => {
    const memUsage = process.memoryUsage();
    longTerm.serverLoad24h.push({
      t: new Date().toISOString(),
      mem: Math.round(memUsage.rss / 1024 / 1024),
      lag: Math.round(metrics.eventLoopLag),
      rps: metrics.requestsPerSecond,
    });
    // Keep exactly 144 points
    if (longTerm.serverLoad24h.length > 144) {
      longTerm.serverLoad24h.shift();
    }
  }, 600000).unref();
}

// ═══════════════════════════════════════
// START ALL MONITORS
// ═══════════════════════════════════════
startLagMonitor();
startRpsCounter();
startHistoryRecorder();
startInMemoryRecorders();

// ═══════════════════════════════════════
// ERROR RECORDER
// ═══════════════════════════════════════
function recordError(message, meta = {}) {
  metrics.errors.unshift({
    timestamp: new Date().toISOString(),
    message,
    ...meta,
  });
  if (metrics.errors.length > 100) {
    metrics.errors.length = 100;
  }
}

// ═══════════════════════════════════════
// REDIS CIRCUIT BREAKER
// ═══════════════════════════════════════
function isRedisCircuitOpen() {
  return metrics.eventLoopLag > THRESHOLDS.redisCircuitLag;
}

// ═══════════════════════════════════════
// LOAD SHEDDING MIDDLEWARE
// ═══════════════════════════════════════
function loadSheddingMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  metrics.activeRequests++;
  metrics.totalRequests++;
  rpsCount++;

  const critical = isCriticalPath(req.path);

  // ── Critical lag → shed everything except health ──
  if (metrics.eventLoopLag > THRESHOLDS.criticalLag && !critical) {
    metrics.activeRequests--;
    metrics.rejectedRequests++;
    return res.status(503).json({
      error: 'Server is under heavy load. Please try again in a few seconds.',
      retry_after: 5,
    });
  }

  // ── High lag → shed non-critical ──
  if (metrics.eventLoopLag > THRESHOLDS.shedLag && !critical) {
    metrics.activeRequests--;
    metrics.rejectedRequests++;
    return res.status(503).json({
      error: 'Server is busy. Please try again shortly.',
      retry_after: 3,
    });
  }

  // ── Dynamic concurrency limit ──
  if (metrics.activeRequests > metrics.dynamicMaxRequests && !critical) {
    metrics.activeRequests--;
    metrics.rejectedRequests++;
    return res.status(503).json({
      error: 'Server capacity reached. Please try again shortly.',
      retry_after: 2,
    });
  }

  // ── Request Timeout ──
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      metrics.activeRequests--;
      metrics.timedOutRequests++;
      recordError(`Request timeout: ${req.method} ${req.path}`, { type: 'timeout' });
      logger.warn(`[Timeout] ${req.method} ${req.path} exceeded ${THRESHOLDS.requestTimeoutMs}ms`);
      res.status(504).json({ error: 'Request timed out' });
    }
  }, THRESHOLDS.requestTimeoutMs);

  // ── Cleanup on response finish ──
  const cleanup = () => {
    clearTimeout(timeout);
    if (res._loadShedCleaned) return; // prevent double-decrement
    res._loadShedCleaned = true;
    metrics.activeRequests--;

    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    if (res.statusCode >= 500) {
      recordError(`${res.statusCode} ${req.method} ${req.path}`, {
        type: 'server_error',
        status: res.statusCode,
        duration_ms: durationMs.toFixed(1),
      });
    }
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);

  next();
}

// ═══════════════════════════════════════
// EXPORTS FOR ADMIN PANEL
// ═══════════════════════════════════════
function getMetrics() {
  const memUsage = process.memoryUsage();
  const os = require('os');

  return {
    event_loop_lag_ms: Math.round(metrics.eventLoopLag),
    active_requests: metrics.activeRequests,
    total_requests: metrics.totalRequests,
    rejected_requests: metrics.rejectedRequests,
    timed_out_requests: metrics.timedOutRequests,
    requests_per_second: metrics.requestsPerSecond,
    dynamic_max_requests: metrics.dynamicMaxRequests,
    memory_used_mb: Math.round(memUsage.rss / 1024 / 1024),
    heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
    cpu_load_1m: os.loadavg()[0]?.toFixed(2),
    system_memory_used_pct: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    uptime_seconds: Math.floor(process.uptime()),
    uptime_hours: parseFloat((process.uptime() / 3600).toFixed(1)),
    node_version: process.version,
    platform: process.platform,
  };
}

function getRecentErrors() {
  return metrics.errors;
}

function getAlerts() {
  const os = require('os');
  const memPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

  return {
    high_cpu: parseFloat(os.loadavg()[0]?.toFixed(2)) > 2.0,
    high_memory: memPct > 85,
    high_event_loop_lag: metrics.eventLoopLag > 100,
    high_active_requests: metrics.activeRequests > metrics.dynamicMaxRequests * 0.7,
    redis_circuit_open: isRedisCircuitOpen(),
    load_shedding_active: metrics.eventLoopLag > THRESHOLDS.shedLag,
  };
}

function getHistory() {
  return history;
}

function getLongTermMetrics() {
  return longTerm;
}

module.exports = {
  loadSheddingMiddleware,
  getMetrics,
  getRecentErrors,
  getAlerts,
  getHistory,
  getLongTermMetrics,
  recordError,
  isRedisCircuitOpen,
};
