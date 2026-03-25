'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const logger = require('../config/logger');

// GET /notifications
router.get('/', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: notifications, error } = await supabase
      .from('notifications')
      .select(`
        *,
        actor:users!notifications_actor_id_fkey(id, name, profile_image, role)
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({ notifications: notifications || [] });
  } catch (err) {
    logger.error('Get notifications error:', err);
    return res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// PUT /notifications/read
router.put('/read', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', user.id)
      .eq('is_read', false);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Mark notifications read error:', err);
    return res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// DELETE /notifications/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { id } = req.params;
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify ownership
    const { data: notification } = await supabase
      .from('notifications')
      .select('user_id')
      .eq('id', id)
      .single();

    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    if (notification.user_id !== user.id) return res.status(403).json({ error: 'Unauthorized to delete this notification' });

    await supabase.from('notifications').delete().eq('id', id);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Delete notification error:', err);
    return res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// POST /notifications/register-token
router.post('/register-token', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;
    const { fcm_token, device_info } = req.body;

    if (!fcm_token) return res.status(400).json({ error: 'FCM token is required' });

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Upsert token (update if exists, insert if not)
    const { error } = await supabase
      .from('device_tokens')
      .upsert({
        user_id: user.id,
        fcm_token,
        device_info: device_info || '',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'fcm_token' });

    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    logger.error('Register token error:', err);
    return res.status(500).json({ error: 'Failed to register token' });
  }
});

// DELETE /notifications/remove-token
router.delete('/remove-token', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;
    const { fcm_token } = req.body;

    if (!fcm_token) return res.status(400).json({ error: 'FCM token is required' });

    // Get current user
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Only delete tokens owned by this user
    await supabase
      .from('device_tokens')
      .delete()
      .eq('fcm_token', fcm_token)
      .eq('user_id', user.id);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Remove token error:', err);
    return res.status(500).json({ error: 'Failed to remove token' });
  }
});

module.exports = router;
