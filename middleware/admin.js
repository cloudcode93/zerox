'use strict';

const logger = require('../config/logger');

/**
 * Admin authorization middleware.
 * Must be used after authMiddleware (req.supabaseUser must exist).
 * 
 * Checks if the authenticated user has is_admin = true in the database.
 */
const adminMiddleware = async (req, res, next) => {
  try {
    const supabase = req.app.get('supabase');
    const { data: user, error } = await supabase
      .from('users')
      .select('is_admin')
      .eq('supabase_uid', req.supabaseUser.id)
      .single();

    if (error || !user || !user.is_admin) {
      return res.status(403).json({ error: 'Forbidden: Admin access only' });
    }
    next();
  } catch (err) {
    logger.error('Admin middleware error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = adminMiddleware;
