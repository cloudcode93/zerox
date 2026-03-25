'use strict';

const { getRedis } = require('../config/redis');
const logger = require('../config/logger');

/**
 * Redis Cache Layer
 * 
 * Provides simple get/set/del operations with JSON serialization.
 * All keys are prefixed with `zerox:cache:` to avoid collisions.
 * 
 * Usage:
 *   const cache = require('../lib/cache');
 *   const data = await cache.get('feed:page:1');
 *   if (!data) {
 *     const fresh = await fetchFromDB();
 *     await cache.set('feed:page:1', fresh, 60); // 60s TTL
 *   }
 */

const PREFIX = 'zerox:cache:';

/**
 * Get a cached value by key. Returns parsed JSON or null.
 */
async function get(key) {
  try {
    const redis = getRedis();
    const raw = await redis.get(`${PREFIX}${key}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.error(`[Cache] GET error for key "${key}":`, err.message);
    return null; // Fail open — cache miss, not a crash
  }
}

/**
 * Set a cached value with TTL in seconds.
 * @param {string} key 
 * @param {*} data - Will be JSON.stringify'd
 * @param {number} ttlSeconds - Time to live in seconds (default: 60)
 */
async function set(key, data, ttlSeconds = 60) {
  try {
    const redis = getRedis();
    await redis.setex(`${PREFIX}${key}`, ttlSeconds, JSON.stringify(data));
  } catch (err) {
    logger.error(`[Cache] SET error for key "${key}":`, err.message);
  }
}

/**
 * Delete a specific cached key.
 */
async function del(key) {
  try {
    const redis = getRedis();
    await redis.del(`${PREFIX}${key}`);
  } catch (err) {
    logger.error(`[Cache] DEL error for key "${key}":`, err.message);
  }
}

/**
 * Delete all keys matching a glob pattern.
 * Example: delPattern('feed:*') removes all cached feed pages.
 * Uses SCAN to avoid blocking Redis with KEYS command.
 */
async function delPattern(pattern) {
  try {
    const redis = getRedis();
    const fullPattern = `${PREFIX}${pattern}`;
    let cursor = '0';
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');

    if (totalDeleted > 0) {
      logger.debug(`[Cache] Cleared ${totalDeleted} keys matching "${pattern}"`);
    }
  } catch (err) {
    logger.error(`[Cache] delPattern error for "${pattern}":`, err.message);
  }
}

module.exports = { get, set, del, delPattern };
