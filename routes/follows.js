const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { createAndDeliverNotification } = require('../services/notification_service');

// POST /follow/toggle
router.post('/toggle', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const supabaseUser = req.supabaseUser;
    const { following_id } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('id, name')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === following_id) return res.status(400).json({ error: 'Cannot follow yourself' });

    // Check if already following
    const { data: existing } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', user.id)
      .eq('following_id', following_id)
      .single();

    if (existing) {
      // Unfollow
      await supabase.from('follows').delete().eq('id', existing.id);
      // Update counts
      await supabase.rpc('decrement_following', { user_uuid: user.id });
      await supabase.rpc('decrement_followers', { user_uuid: following_id });

      return res.json({ following: false });
    } else {
      // Check block status before following
      const { data: blockCheck } = await supabase
        .from('user_blocks')
        .select('id')
        .or(`and(blocker_id.eq.${user.id},blocked_id.eq.${following_id}),and(blocker_id.eq.${following_id},blocked_id.eq.${user.id})`)
        .limit(1);

      if (blockCheck && blockCheck.length > 0) {
        return res.status(403).json({ error: 'Cannot follow due to block settings' });
      }

      // Follow
      await supabase.from('follows').insert({ follower_id: user.id, following_id });
      // Update counts
      await supabase.rpc('increment_following', { user_uuid: user.id });
      await supabase.rpc('increment_followers', { user_uuid: following_id });

      // Create notification with smart delivery
      await createAndDeliverNotification(supabase, io, onlineUsers, {
        userId: following_id,
        actorId: user.id,
        type: 'follow',
        referenceId: user.id,
        message: `${user.name} started following you`,
      });

      return res.json({ following: true });
    }
  } catch (err) {
    console.error('Toggle follow error:', err);
    return res.status(500).json({ error: 'Failed to toggle follow' });
  }
});

// GET /follow/followers/:userId
router.get('/followers/:userId', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('follows')
      .select(`
        follower:users!follows_follower_id_fkey(id, name, profile_image, role, bio)
      `)
      .eq('following_id', userId);

    if (error) throw error;
    return res.json({ followers: (data || []).map(d => d.follower) });
  } catch (err) {
    console.error('Get followers error:', err);
    return res.status(500).json({ error: 'Failed to get followers' });
  }
});

// GET /follow/following/:userId
router.get('/following/:userId', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('follows')
      .select(`
        following:users!follows_following_id_fkey(id, name, profile_image, role, bio)
      `)
      .eq('follower_id', userId);

    if (error) throw error;
    return res.json({ following: (data || []).map(d => d.following) });
  } catch (err) {
    console.error('Get following error:', err);
    return res.status(500).json({ error: 'Failed to get following' });
  }
});

module.exports = router;
