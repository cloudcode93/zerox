'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate Limiters — Hybrid IP + User-Based
 * 
 * Two layers of protection:
 *   1. IP-based: catches bots, scrapers, unauthenticated abuse
 *   2. User-based: prevents authenticated users from abusing endpoints
 * 
 * Uses in-memory store (sufficient for single-instance).
 */

// ── Key generator: IP + authenticated user ID ──
function hybridKeyGenerator(req) {
  // If authenticated, rate limit by user ID (prevents multi-device abuse)
  // Falls back to IP for unauthenticated requests
  const userId = req.user?.id || req.supabaseUser?.id;
  if (userId) return `user:${userId}`;
  return req.ip;
}

// ═══════════════════════════════════════
// GLOBAL LIMITERS
// ═══════════════════════════════════════

// Catches rapid-fire spam/bots (10 requests per 10 seconds)
const spamLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

// General rate limit (200 per 15 minutes per IP)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ═══════════════════════════════════════
// PER-ENDPOINT LIMITERS (hybrid key)
// ═══════════════════════════════════════

// Expensive read endpoints (feed, discover, trending, search)
const heavyApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: hybridKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to this endpoint. Please wait.' },
});

// Post creation
const postsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: hybridKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You have reached your post limit. Please try again later.' },
});

// Comments
const commentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: hybridKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many comments, please slow down.' },
});

// Auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many actions, please slow down.' },
});

// Chat creation
const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: hybridKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat creations. Please try again later.' },
});

// Like/follow toggle (prevents spam-toggling)
const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: hybridKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many actions. Please slow down.' },
});

module.exports = {
  generalLimiter,
  spamLimiter,
  heavyApiLimiter,
  postsLimiter,
  commentsLimiter,
  authLimiter,
  chatLimiter,
  actionLimiter,
};
