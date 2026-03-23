const { createClient } = require('@supabase/supabase-js');

// Middleware to verify Supabase JWT
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
      {
        global: {
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    );

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    let isMaintenance = false;
    try {
      const settingsPath = require('path').join(__dirname, '../settings.json');
      const settings = JSON.parse(require('fs').readFileSync(settingsPath));
      isMaintenance = settings.maintenance_mode === true;
    } catch (e) {}

    // Check user state
    const { data: dbUser } = await supabase
      .from('users')
      .select('is_banned, is_admin')
      .eq('supabase_uid', user.id)
      .single();

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
