'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const logger = require('../config/logger');
const cache = require('../lib/cache');

// GET /user/by-uid/:uid
router.get('/by-uid/:uid', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { uid } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('supabase_uid', uid)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user });
  } catch (err) {
    logger.error('Get user by UID error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// GET /user/:id (profile - cached 30s)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { id } = req.params;
    const supabaseUser = req.supabaseUser;

    // Try cache first
    const cacheKey = `profile:${id}`;
    let profile = await cache.get(cacheKey);

    if (!profile) {
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !user) return res.status(404).json({ error: 'User not found' });
      profile = user;
      await cache.set(cacheKey, profile, 30);
    }

    // Personalization (always fresh)
    const { data: viewer } = await supabase.from('users').select('id').eq('supabase_uid', supabaseUser.id).single();
    let is_following = false;
    let is_blocked = false;

    if (viewer) {
      const [{ data: followData }, { data: blockData }] = await Promise.all([
        supabase.from('follows').select('id').eq('follower_id', viewer.id).eq('following_id', id).maybeSingle(),
        supabase.from('user_blocks').select('id').eq('blocker_id', viewer.id).eq('blocked_id', id).maybeSingle(),
      ]);
      is_following = !!followData;
      is_blocked = !!blockData;
    }

    return res.json({ user: { ...profile, is_following, is_blocked } });
  } catch (err) {
    logger.error('Get user profile error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// PUT /user/update
router.put('/update', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;
    const { name, bio, profile_image, role, investment_range_min, investment_range_max, sectors_of_interest } = req.body;

    const AllowedFields = ['name', 'bio', 'profile_image', 'role', 'investment_range_min', 'investment_range_max', 'sectors_of_interest'];
    const updateData = {};
    if (name !== undefined) updateData.name = String(name).substring(0, 100);
    if (bio !== undefined) updateData.bio = String(bio).substring(0, 500);
    if (profile_image !== undefined) updateData.profile_image = profile_image;
    if (role !== undefined && ['founder', 'investor'].includes(role)) updateData.role = role;
    if (investment_range_min !== undefined) updateData.investment_range_min = Number(investment_range_min);
    if (investment_range_max !== undefined) updateData.investment_range_max = Number(investment_range_max);
    if (sectors_of_interest !== undefined) updateData.sectors_of_interest = sectors_of_interest;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('supabase_uid', supabaseUser.id)
      .select()
      .single();

    if (error) throw error;

    // Invalidate profile cache
    if (user) await cache.del(`profile:${user.id}`);

    return res.json({ user });
  } catch (err) {
    logger.error('Update user error:', err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// GET /user/:id/ideas
router.get('/:id/ideas', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { id } = req.params;
    const supabaseUser = req.supabaseUser;

    const { data: ideas, error } = await supabase
      .from('ideas')
      .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
      .eq('user_id', id)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich with like/interest status
    const { data: viewer } = await supabase.from('users').select('id').eq('supabase_uid', supabaseUser.id).single();
    if (viewer && ideas?.length > 0) {
      const ideaIds = ideas.map(i => i.id);
      const [{ data: userLikes }, { data: userInterests }] = await Promise.all([
        supabase.from('likes').select('idea_id').eq('user_id', viewer.id).in('idea_id', ideaIds),
        supabase.from('interests').select('idea_id, status').eq('investor_id', viewer.id).in('idea_id', ideaIds),
      ]);
      const likedSet = new Set((userLikes || []).map(l => l.idea_id));
      const interestMap = {};
      (userInterests || []).forEach(i => { interestMap[i.idea_id] = i.status; });

      const enriched = ideas.map(idea => ({
        ...idea,
        is_liked: likedSet.has(idea.id),
        interest_status: interestMap[idea.id] || null,
      }));
      return res.json({ ideas: enriched });
    }

    return res.json({ ideas: ideas || [] });
  } catch (err) {
    logger.error('Get user ideas error:', err);
    return res.status(500).json({ error: 'Failed to get ideas' });
  }
});

// GET /user/popular/list (cached 300s)
router.get('/popular/list', authMiddleware, async (req, res) => {
  try {
    const cacheKey = 'popular:users';
    let users = await cache.get(cacheKey);

    if (!users) {
      const supabase = req.app.get('supabase');
      const { data, error } = await supabase
        .from('users')
        .select('id, name, profile_image, role, bio, followers_count')
        .order('followers_count', { ascending: false })
        .limit(20);

      if (error) throw error;
      users = data || [];
      await cache.set(cacheKey, users, 300);
    }

    return res.json({ users });
  } catch (err) {
    logger.error('Get popular users error:', err);
    return res.status(500).json({ error: 'Failed to get popular users' });
  }
});

// POST /user/block
router.post('/block', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;
    const { blocked_id } = req.body;

    const { data: user } = await supabase.from('users').select('id').eq('supabase_uid', supabaseUser.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === blocked_id) return res.status(400).json({ error: 'Cannot block yourself' });

    const { data: existingBlock } = await supabase
      .from('user_blocks')
      .select('id')
      .eq('blocker_id', user.id)
      .eq('blocked_id', blocked_id)
      .single();

    if (existingBlock) return res.status(409).json({ error: 'User already blocked' });

    await supabase.from('user_blocks').insert({ blocker_id: user.id, blocked_id });

    // Unfollow in both directions
    await supabase.from('follows').delete().eq('follower_id', user.id).eq('following_id', blocked_id);
    await supabase.from('follows').delete().eq('follower_id', blocked_id).eq('following_id', user.id);

    return res.json({ success: true, message: 'User blocked' });
  } catch (err) {
    logger.error('Block user error:', err);
    return res.status(500).json({ error: 'Failed to block user' });
  }
});

// DELETE /user/unblock
router.delete('/unblock', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;
    const { blocked_id } = req.body;

    const { data: user } = await supabase.from('users').select('id').eq('supabase_uid', supabaseUser.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    await supabase.from('user_blocks').delete().eq('blocker_id', user.id).eq('blocked_id', blocked_id);

    return res.json({ success: true, message: 'User unblocked' });
  } catch (err) {
    logger.error('Unblock user error:', err);
    return res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// GET /user/blocked/list
router.get('/blocked/list', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase.from('users').select('id').eq('supabase_uid', supabaseUser.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: blocks, error } = await supabase
      .from('user_blocks')
      .select('blocked:users!user_blocks_blocked_id_fkey(id, name, profile_image, role)')
      .eq('blocker_id', user.id);

    if (error) throw error;
    return res.json({ blocked_users: (blocks || []).map(b => b.blocked) });
  } catch (err) {
    logger.error('Get blocked list error:', err);
    return res.status(500).json({ error: 'Failed to get blocked users' });
  }
});

// GET /user/search/investors
router.get('/search/investors', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { min, max, sectors } = req.query;

    let query = supabase
      .from('users')
      .select('id, name, profile_image, role, bio, investment_range_min, investment_range_max, sectors_of_interest, followers_count')
      .eq('role', 'investor');

    if (min) query = query.gte('investment_range_max', Number(min));
    if (max) query = query.lte('investment_range_min', Number(max));
    if (sectors) {
      const sectorList = sectors.split(',').map(s => s.trim());
      query = query.overlaps('sectors_of_interest', sectorList);
    }

    const { data: investors, error } = await query.order('followers_count', { ascending: false }).limit(50);
    if (error) throw error;

    // If no exact match, find nearby
    if ((!investors || investors.length === 0) && (min || max)) {
      const targetAmount = Number(min || max);
      const { data: nearby } = await supabase
        .from('users')
        .select('id, name, profile_image, role, bio, investment_range_min, investment_range_max, sectors_of_interest, followers_count')
        .eq('role', 'investor')
        .order('followers_count', { ascending: false })
        .limit(20);

      const sorted = (nearby || [])
        .filter(u => u.investment_range_min || u.investment_range_max)
        .map(u => ({
          ...u,
          distance: Math.min(
            Math.abs((u.investment_range_min || 0) - targetAmount),
            Math.abs((u.investment_range_max || 0) - targetAmount),
          ),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);

      return res.json({ investors: sorted, is_nearby: true });
    }

    return res.json({ investors: investors || [], is_nearby: false });
  } catch (err) {
    logger.error('Search investors error:', err);
    return res.status(500).json({ error: 'Failed to search investors' });
  }
});

module.exports = router;
