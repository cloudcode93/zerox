/**
 * Rate Limiters — Redis-backed for multi-server consistency
 * Without Redis store, each of the 3 servers has independent counters,
 * meaning a user effectively gets 3× the allowed limit.
 */
const rateLimit = require('express-rate-limit');

let RedisStore;
let redisClient;

// Try to load Redis store
try {
  const { RedisStore: RS } = require('rate-limit-redis');
  const { getRedis, getIsConnected } = require('../services/redis');
  RedisStore = RS;
  redisClient = getRedis();
  if (redisClient && getIsConnected()) {
    console.log('[Limiters] Using Redis-backed rate limiting');
  } else {
    redisClient = null;
  }
} catch (err) {
  console.warn('[Limiters] Redis store not available — using local memory');
}

function createStore(prefix) {
  if (RedisStore && redisClient) {
    return new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: `rl:${prefix}:`,
    });
  }
  return undefined; // falls back to express-rate-limit's default MemoryStore
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore('gen'),
});

const postsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'You have reached your post limit. Please try again later.' },
  store: createStore('post'),
});

const commentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Too many comments, please slow down.' },
  store: createStore('cmt'),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many actions, please slow down.' },
  store: createStore('auth'),
});

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many chat creations. Please try again later.' },
  store: createStore('chat'),
});

module.exports = {
  generalLimiter,
  postsLimiter,
  commentsLimiter,
  authLimiter,
  chatLimiter,
};
