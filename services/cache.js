/**
 * Two-Tier Cache: Redis (shared) → Local Map (fallback)
 * - Redis primary: shared across all 3 server instances
 * - Local Map fallback: used when Redis is down
 * - LRU eviction: local cache capped at MAX_LOCAL_ENTRIES
 */
const { getRedis, getIsConnected } = require('./redis');

const MAX_LOCAL_ENTRIES = 500;
const localCache = new Map(); // key → { value, expiresAt }

// ── Local cache helpers ──
function localGet(key) {
  const entry = localCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    localCache.delete(key);
    return null;
  }
  // Move to end (LRU)
  localCache.delete(key);
  localCache.set(key, entry);
  return entry.value;
}

function localSet(key, value, ttlSeconds) {
  // Evict oldest if at capacity
  if (localCache.size >= MAX_LOCAL_ENTRIES) {
    const oldest = localCache.keys().next().value;
    localCache.delete(oldest);
  }
  localCache.set(key, {
    value,
    expiresAt: Date.now() + (ttlSeconds * 1000),
  });
}

function localDelete(key) {
  localCache.delete(key);
}

// ── Public API ──

/**
 * Get a cached value. Tries Redis first, falls back to local.
 */
async function get(key) {
  try {
    const redis = getRedis();
    if (redis && getIsConnected()) {
      const val = await redis.get(key);
      if (val) return JSON.parse(val);
    }
  } catch (err) {
    console.error('[Cache] Redis GET error:', err.message);
  }
  // Fallback to local
  return localGet(key);
}

/**
 * Set a cached value in both Redis and local.
 */
async function set(key, value, ttlSeconds = 60) {
  // Always set locally
  localSet(key, value, ttlSeconds);

  try {
    const redis = getRedis();
    if (redis && getIsConnected()) {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }
  } catch (err) {
    console.error('[Cache] Redis SET error:', err.message);
  }
}

/**
 * Invalidate a specific key from both caches.
 */
async function invalidate(key) {
  localDelete(key);
  try {
    const redis = getRedis();
    if (redis && getIsConnected()) {
      await redis.del(key);
    }
  } catch (err) {
    console.error('[Cache] Redis DEL error:', err.message);
  }
}

/**
 * Invalidate all keys matching a prefix pattern.
 * Example: invalidatePattern('feed:*') clears all feed cache
 */
async function invalidatePattern(pattern) {
  // Clear matching local keys
  for (const key of localCache.keys()) {
    if (key.startsWith(pattern.replace('*', ''))) {
      localCache.delete(key);
    }
  }

  try {
    const redis = getRedis();
    if (redis && getIsConnected()) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== '0');
    }
  } catch (err) {
    console.error('[Cache] Redis pattern invalidate error:', err.message);
  }
}

/**
 * Get local cache stats (for monitoring)
 */
function stats() {
  return {
    localSize: localCache.size,
    maxLocal: MAX_LOCAL_ENTRIES,
    redisConnected: getIsConnected(),
  };
}

module.exports = { get, set, invalidate, invalidatePattern, stats };
