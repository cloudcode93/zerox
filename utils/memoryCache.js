'use strict';

/**
 * Simple in-memory cache to reduce high-frequency reads to Redis/DB.
 * Suitable for a single-instance Node.js backend to absorb transient spikes.
 */

const cache = new Map();

/**
 * @param {string} key - Cache key
 * @param {any} value - Value to store
 * @param {number} ttlSeconds - Time-to-live in seconds
 */
function setCache(key, value, ttlSeconds = 10) {
  const expiresAt = Date.now() + (ttlSeconds * 1000);
  cache.set(key, { value, expiresAt });
}

/**
 * @param {string} key - Cache key
 * @returns {any|null} The cached value if valid, null if expired or missing
 */
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

/**
 * Periodically clean up expired keys to prevent memory leaks.
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of cache.entries()) {
    if (now > item.expiresAt) {
      cache.delete(key);
    }
  }
}, 60000).unref();

module.exports = {
  setCache,
  getCache,
};
