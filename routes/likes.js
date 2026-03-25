'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { createAndDeliverNotification } = require('../services/notification_service');
const logger = require('../config/logger');
const cache = require('../lib/cache');

// POST /like/toggle
router.post('/toggle', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const supabaseUser = req.supabaseUser;
    const { idea_id } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('id, name')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if already liked
    const { data: existing } = await supabase
      .from('likes')
      .select('id')
      .eq('user_id', user.id)
      .eq('idea_id', idea_id)
      .single();

    if (existing) {
      // Unlike
      await supabase.from('likes').delete().eq('id', existing.id);
      await supabase.rpc('decrement_likes', { idea_uuid: idea_id });

      // Invalidate trending cache
      await cache.del('trending');

      return res.json({ liked: false });
    } else {
      // Like
      await supabase.from('likes').insert({ user_id: user.id, idea_id });
      await supabase.rpc('increment_likes', { idea_uuid: idea_id });

      // Invalidate trending cache
      await cache.del('trending');

      // Create notification with smart delivery
      const { data: idea } = await supabase
        .from('ideas')
        .select('user_id')
        .eq('id', idea_id)
        .single();

      if (idea && idea.user_id !== user.id) {
        await createAndDeliverNotification(supabase, io, onlineUsers, {
          userId: idea.user_id,
          actorId: user.id,
          type: 'like',
          referenceId: idea_id,
          message: `${user.name} liked your idea`,
        });
      }

      return res.json({ liked: true });
    }
  } catch (err) {
    logger.error('Toggle like error:', err);
    return res.status(500).json({ error: 'Failed to toggle like' });
  }
});

module.exports = router;
