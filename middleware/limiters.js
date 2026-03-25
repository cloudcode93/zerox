'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate Limiters
 * 
 * Uses in-memory store (sufficient for single-instance).
 * When scaling to multi-instance, swap to RedisStore:
 *   const { RedisStore } = require('rate-limit-redis');
 *   store: new RedisStore({ sendCommand: (...args) => redis.call(...args) })
 */

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const postsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You have reached your post limit. Please try again later.' },
});

const commentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many comments, please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many actions, please slow down.' },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat creations. Please try again later.' },
});

module.exports = {
  generalLimiter,
  postsLimiter,
  commentsLimiter,
  authLimiter,
  chatLimiter,
};
