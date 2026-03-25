'use strict';

const { createClient } = require('@supabase/supabase-js');
const logger = require('../config/logger');

/**
 * Auth Middleware
 * 
 * Verifies Supabase JWT from Authorization header.
 * Sets req.user and req.supabaseUser on success.
 * Checks for banned users, maintenance mode, and blocks accordingly.
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check maintenance mode from Redis
    let isMaintenance = false;
    try {
      const { getRedis } = require('../config/redis');
      const redis = getRedis();
      const val = await redis.hget('zerox:settings', 'maintenance_mode');
      isMaintenance = val === 'true';
    } catch (e) {
      // Redis unavailable — allow through
    }

    // Check user state
    const serviceSupabase = req.app.get('supabase');
    const { data: dbUser } = await serviceSupabase
      .from('users')
      .select('is_banned, is_admin')
      .eq('supabase_uid', user.id)
      .single();

    if (isMaintenance && (!dbUser || !dbUser.is_admin)) {
      return res.status(503).json({ error: 'maintenance' });
    }

    // Allow basic identity routes for banned users (GET only)
    const isGetRequest = req.method === 'GET';
    const isAllowedIfBanned = req.originalUrl.includes('/auth/sync-user') ||
                              (isGetRequest && req.originalUrl.match(/^\/user\/by-uid\/[^/]+$/)) ||
                              (isGetRequest && req.originalUrl.match(/^\/user\/[0-9a-f-]+$/));

    if (dbUser && dbUser.is_banned && !isAllowedIfBanned) {
      return res.status(403).json({ error: 'Your account has been banned for violating our terms of service.' });
    }

    req.user = user;
    req.supabaseUser = user;
    next();
  } catch (err) {
    logger.error('Auth middleware error:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

module.exports = authMiddleware;
