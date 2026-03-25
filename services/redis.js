/**
 * Redis Connection Manager (Upstash-compatible)
 * Provides: main client, pub/sub pair for Socket.IO adapter
 * Graceful fallback: app continues without Redis (degraded mode)
 */
const Redis = require('ioredis');

let redis = null;
let pub = null;
let sub = null;
let isConnected = false;

const REDIS_URL = process.env.REDIS_URL;

function createClient(label = 'main') {
  if (!REDIS_URL) {
    console.warn(`[Redis:${label}] No REDIS_URL — running in local-only mode`);
    return null;
  }

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 5000);
    },
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
    lazyConnect: false,
  });

  client.on('connect', () => {
    console.log(`[Redis:${label}] Connected`);
    if (label === 'main') isConnected = true;
  });

  client.on('error', (err) => {
    console.error(`[Redis:${label}] Error:`, err.message);
    if (label === 'main') isConnected = false;
  });

  client.on('close', () => {
    if (label === 'main') isConnected = false;
  });

  return client;
}

function init() {
  if (!REDIS_URL) {
    console.warn('[Redis] REDIS_URL not set — all caching will be local-only');
    return;
  }
  redis = createClient('main');
  pub = createClient('pub');
  sub = createClient('sub');
}

function getRedis() { return redis; }
function getPub() { return pub; }
function getSub() { return sub; }
function getIsConnected() { return isConnected; }

async function shutdown() {
  const clients = [redis, pub, sub].filter(Boolean);
  await Promise.allSettled(clients.map(c => c.quit()));
  console.log('[Redis] All connections closed');
}

module.exports = { init, getRedis, getPub, getSub, getIsConnected, shutdown };
