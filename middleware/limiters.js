const rateLimit = require('express-rate-limit');

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // lowered from 1000
  message: { error: 'Too many requests, please try again later.' }
});

const postsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 posts per hour
  message: { error: 'You have reached your post limit. Please try again later.' }
});

const commentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 comments per hour
  message: { error: 'Too many comments, please slow down.' }
});

// Stricter limiter for sensitive/abuse-prone endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 per 15 minutes
  message: { error: 'Too many actions, please slow down.' }
});

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20, // 20 chat creations per hour
  message: { error: 'Too many chat creations. Please try again later.' }
});

module.exports = {
  generalLimiter,
  postsLimiter,
  commentsLimiter,
  authLimiter,
  chatLimiter
};
