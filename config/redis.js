'use strict';

const Redis = require('ioredis');
const logger = require('./logger');

/**
 * Shared Redis connection for the entire application.
 * Used by: BullMQ, Cache, Rate Limiters, Settings store, Online users.
 * 
 * Supports both local Redis (redis://) and cloud Redis with TLS (rediss://).
 * Upstash, Render Redis, and similar services use rediss:// for TLS.
 */

let redis = null;

/**
 * Parse Redis options. Handles rediss:// TLS URLs automatically.
 */
function getRedisOptions() {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const isTLS = redisUrl.startsWith('rediss://');

  const opts = {
    maxRetriesPerRequest: null,       // Required for BullMQ compatibility
    enableReadyCheck: true,
    connectTimeout: 10000,
    retryStrategy(times) {
      if (times > 20) {
        logger.error('[Redis] Max retries reached, giving up');
        return null;
      }
      return Math.min(times * 200, 3000);
    },
    reconnectOnError(err) {
      return ['READONLY', 'ECONNRESET'].some(e => err.message.includes(e));
    },
  };

  // Upstash and cloud Redis require TLS
  if (isTLS) {
    opts.tls = { rejectUnauthorized: false };
  }

  return { redisUrl, opts };
}

function getRedis() {
  if (redis) return redis;

  const { redisUrl, opts } = getRedisOptions();
  redis = new Redis(redisUrl, opts);

  redis.on('connect', () => logger.info('[Redis] Connected'));
  redis.on('ready', () => logger.info('[Redis] Ready to accept commands'));
  redis.on('error', (err) => logger.error('[Redis] Connection error:', err.message));
  redis.on('close', () => logger.warn('[Redis] Connection closed'));

  return redis;
}

/**
 * Create a duplicate connection for BullMQ subscribers.
 * BullMQ requires separate connections for Queue and Worker.
 */
function createRedisConnection() {
  const { redisUrl, opts } = getRedisOptions();
  const conn = new Redis(redisUrl, opts);

  // Attach error handler to prevent unhandled ioredis error events
  conn.on('error', (err) => {
    logger.error('[Redis:Worker] Connection error:', err.message);
  });

  return conn;
}

/**
 * Gracefully close the shared Redis connection.
 */
async function closeRedis() {
  if (redis) {
    logger.info('[Redis] Closing connection...');
    await redis.quit();
    redis = null;
  }
}

module.exports = { getRedis, createRedisConnection, closeRedis };
