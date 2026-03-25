'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { commentsLimiter } = require('../middleware/limiters');
const { createAndDeliverNotification } = require('../services/notification_service');
const logger = require('../config/logger');
const cache = require('../lib/cache');

// POST /comment/add
router.post('/add', authMiddleware, commentsLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const supabaseUser = req.supabaseUser;
    const { idea_id, comment } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('id, name')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: newComment, error } = await supabase
      .from('comments')
      .insert({ user_id: user.id, idea_id, comment })
      .select(`
        *,
        user:users!comments_user_id_fkey(id, name, profile_image, role)
      `)
      .single();

    if (error) throw error;

    // Increment comments count
    await supabase.rpc('increment_comments', { idea_uuid: idea_id });

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
        type: 'comment',
        referenceId: idea_id,
        message: `${user.name} commented on your idea`,
      });
    }

    return res.json({ comment: newComment });
  } catch (err) {
    logger.error('Add comment error:', err);
    return res.status(500).json({ error: 'Failed to add comment' });
  }
});

// GET /comment/:ideaId
router.get('/:ideaId', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { ideaId } = req.params;

    const { data: comments, error } = await supabase
      .from('comments')
      .select(`
        *,
        user:users!comments_user_id_fkey(id, name, profile_image, role)
      `)
      .eq('idea_id', ideaId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return res.json({ comments: comments || [] });
  } catch (err) {
    logger.error('Get comments error:', err);
    return res.status(500).json({ error: 'Failed to get comments' });
  }
});

module.exports = router;
