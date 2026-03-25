const { createClient } = require('@supabase/supabase-js');
const cache = require('../services/cache');

// Middleware to verify Supabase JWT with Redis-cached user lookups
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];

    // Create a supabase client with the user's token to verify
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check maintenance mode (cached for 30s to avoid file reads)
    let isMaintenance = await cache.get('settings:maintenance_mode');
    if (isMaintenance === null) {
      try {
        const settingsPath = require('path').join(__dirname, '../settings.json');
        const settings = JSON.parse(require('fs').readFileSync(settingsPath));
        isMaintenance = settings.maintenance_mode === true;
        await cache.set('settings:maintenance_mode', isMaintenance, 30);
      } catch (e) {
        isMaintenance = false;
      }
    }

    // Check user state (cached for 60s)
    let dbUser = await cache.get(`auth_user:${user.id}`);
    if (!dbUser) {
      const { data } = await supabase
        .from('users')
        .select('is_banned, is_admin')
        .eq('supabase_uid', user.id)
        .single();
      dbUser = data;
      if (dbUser) {
        await cache.set(`auth_user:${user.id}`, dbUser, 60);
      }
    }

    if (isMaintenance && (!dbUser || !dbUser.is_admin)) {
      return res.status(503).json({ error: 'maintenance' });
    }

    // Allow basic identity routes so the app can fetch the ban status (GET only)
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
    console.error('Auth middleware error:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

module.exports = authMiddleware;
