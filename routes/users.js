const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { authLimiter } = require('../middleware/limiters');

// ═══════════════════════════════════════════════════════════
// HELPER: Get current user (cached)
// ═══════════════════════════════════════════════════════════
async function getCurrentUser(supabase, supabaseUser, cache) {
  if (cache) {
    const cached = await cache.get(`current_user:${supabaseUser.id}`);
    if (cached) return cached;
  }
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('supabase_uid', supabaseUser.id)
    .single();
  if (user && cache) await cache.set(`current_user:${supabaseUser.id}`, user, 120);
  return user;
}

const USER_FIELDS = 'id, supabase_uid, name, email, profile_image, role, bio, location, website, linkedin_url, investment_range, ideas_count, followers_count, following_count, is_admin, is_banned';

// GET /user/:id - Get user profile (cached 60s)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { id } = req.params;
    const currentUserId = req.supabaseUser.id;

    // Try cache for the target user profile
    let user = cache ? await cache.get(`user_profile:${id}`) : null;
    if (!user) {
      const { data, error } = await supabase
        .from('users')
        .select(USER_FIELDS)
        .eq('id', id)
        .single();

      if (error || !data) return res.status(404).json({ error: 'User not found' });
      user = data;
      if (cache) await cache.set(`user_profile:${id}`, user, 60);
    }

    if (user.is_banned === true) {
      return res.json({
        user: {
          id: user.id, name: user.name, profile_image: user.profile_image,
          is_banned: true, is_following: false, has_blocked: false, is_blocked: false
        }
      });
    }

    // Get current user to check relationships
    const currentUser = await getCurrentUser(supabase, req.supabaseUser, cache);

    let isFollowing = false;
    let hasBlocked = false;
    let isBlocked = false;

    if (currentUser) {
      // Parallel relationship checks
      const [{ data: follow }, { data: blockOut }, { data: blockIn }] = await Promise.all([
        supabase.from('follows').select('id').eq('follower_id', currentUser.id).eq('following_id', id).maybeSingle(),
        supabase.from('user_blocks').select('id').eq('blocker_id', currentUser.id).eq('blocked_id', id).maybeSingle(),
        supabase.from('user_blocks').select('id').eq('blocker_id', id).eq('blocked_id', currentUser.id).maybeSingle(),
      ]);
      isFollowing = !!follow;
      hasBlocked = !!blockOut;
      isBlocked = !!blockIn;
    }

    return res.json({ user: { ...user, is_following: isFollowing, has_blocked: hasBlocked, is_blocked: isBlocked } });
  } catch (err) {
    console.error('Get user error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /user/block
router.post('/block', authMiddleware, authLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { target_id } = req.body;
    const currentUser = await getCurrentUser(supabase, req.supabaseUser, cache);

    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    if (currentUser.id === target_id) return res.status(400).json({ error: 'You cannot block yourself' });

    const { error: blockError } = await supabase
      .from('user_blocks')
      .insert({ blocker_id: currentUser.id, blocked_id: target_id });

    if (blockError && blockError.code !== '23505') throw blockError;

    // Force unfollow both directions
    await Promise.all([
      supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', target_id),
      supabase.from('follows').delete().eq('follower_id', target_id).eq('following_id', currentUser.id),
    ]);

    // Invalidate block cache
    if (cache) {
      const blockKey = `block:${[currentUser.id, target_id].sort().join(':')}`;
      await cache.invalidate(blockKey);
    }

    return res.json({ success: true, message: 'User blocked successfully' });
  } catch (err) {
    console.error('Block user error:', err);
    return res.status(500).json({ error: 'Failed to block user' });
  }
});

// POST /user/unblock
router.post('/unblock', authMiddleware, authLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { target_id } = req.body;
    const currentUser = await getCurrentUser(supabase, req.supabaseUser, cache);

    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const { error } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blocker_id', currentUser.id)
      .eq('blocked_id', target_id);

    if (error) throw error;

    // Invalidate block cache
    if (cache) {
      const blockKey = `block:${[currentUser.id, target_id].sort().join(':')}`;
      await cache.invalidate(blockKey);
    }

    return res.json({ success: true, message: 'User unblocked successfully' });
  } catch (err) {
    console.error('Unblock user error:', err);
    return res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// GET /user/blocks/list
router.get('/blocks/list', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const currentUser = await getCurrentUser(supabase, req.supabaseUser, cache);

    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const { data: blocks, error } = await supabase
      .from('user_blocks')
      .select(`id, blocked_user:blocked_id (id, name, profile_image, role, bio)`)
      .eq('blocker_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const results = blocks ? blocks.map(b => ({ block_id: b.id, ...b.blocked_user })) : [];
    return res.json({ users: results });
  } catch (err) {
    console.error('Get blocked users error:', err);
    return res.status(500).json({ error: 'Failed to list blocked users' });
  }
});

// GET /user/by-uid/:uid
router.get('/by-uid/:uid', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { uid } = req.params;

    let user = cache ? await cache.get(`user_by_uid:${uid}`) : null;
    if (!user) {
      const { data, error } = await supabase
        .from('users')
        .select(USER_FIELDS)
        .eq('supabase_uid', uid)
        .single();

      if (error || !data) return res.status(404).json({ error: 'User not found' });
      user = data;
      if (cache) await cache.set(`user_by_uid:${uid}`, user, 60);
    }

    if (user.is_banned === true) {
      return res.json({
        user: { id: user.id, name: user.name, profile_image: user.profile_image, is_banned: true }
      });
    }

    return res.json({ user });
  } catch (err) {
    console.error('Get user by uid error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// PUT /user/update
router.put('/update', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const supabaseUser = req.supabaseUser;
    const { name, bio, role, linkedin_url, website, location, investment_range } = req.body;

    const ALLOWED_ROLES = ['founder', 'investor'];
    if (role !== undefined && !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${ALLOWED_ROLES.join(', ')}` });
    }

    const MAX_LEN = { name: 100, bio: 500, linkedin_url: 300, website: 300, location: 150, investment_range: 100 };
    const fields = { name, bio, linkedin_url, website, location, investment_range };
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined && typeof val === 'string' && val.length > MAX_LEN[key]) {
        return res.status(400).json({ error: `${key} exceeds maximum length of ${MAX_LEN[key]} characters` });
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (bio !== undefined) updateData.bio = bio;
    if (role !== undefined) updateData.role = role;
    if (linkedin_url !== undefined) updateData.linkedin_url = linkedin_url;
    if (website !== undefined) updateData.website = website;
    if (location !== undefined) updateData.location = location;
    if (investment_range !== undefined) updateData.investment_range = investment_range;

    const { data: user, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('supabase_uid', supabaseUser.id)
      .select()
      .single();

    if (error) throw error;

    // Invalidate user caches
    if (cache) {
      await cache.invalidate(`user_profile:${user.id}`);
      await cache.invalidate(`user_by_uid:${supabaseUser.id}`);
      await cache.invalidate(`current_user:${supabaseUser.id}`);
      await cache.invalidate(`auth_user:${supabaseUser.id}`);
    }

    return res.json({ user });
  } catch (err) {
    console.error('Update user error:', err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// GET /user/popular/list (cached 120s)
router.get('/popular/list', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');

    // Try cache first (warmed by cron every 60s)
    let users = cache ? await cache.get('popular_users') : null;
    if (!users) {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, profile_image, role, followers_count')
        .eq('is_banned', false)
        .order('followers_count', { ascending: false })
        .limit(10);

      if (error) throw error;
      users = data || [];
      if (cache) await cache.set('popular_users', users, 120);
    }

    return res.json({ users });
  } catch (err) {
    console.error('Popular users error:', err);
    return res.status(500).json({ error: 'Failed to fetch popular users' });
  }
});

// GET /user/search/investors (cached 60s by amount)
router.get('/search/investors', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { amount, name } = req.query;

    const cacheKey = `investor_search:${amount || ''}:${name || ''}`;
    let results = cache ? await cache.get(cacheKey) : null;

    if (!results) {
      let query = supabase
        .from('users')
        .select('id, name, profile_image, role, bio, investment_range, followers_count, location')
        .eq('role', 'investor')
        .eq('is_banned', false)
        .order('followers_count', { ascending: false })
        .limit(50);

      if (name) query = query.ilike('name', `%${name}%`);

      const { data: investors, error } = await query;
      if (error) throw error;

      results = investors || [];

      if (amount) {
        const searchAmount = parseInt(amount);
        if (!isNaN(searchAmount)) {
          results = results.map(inv => {
            let midpoint = null;
            if (inv.investment_range) {
              const range = inv.investment_range.replace(/[,$₹€£\s]/g, '').trim();
              const numbers = range.match(/\d+/g);
              if (numbers && numbers.length > 0) {
                let nums = numbers.map(n => parseInt(n));
                nums = nums.map(n => n < 1000 && range.toLowerCase().includes('k') ? n * 1000 : n);
                midpoint = nums.length >= 2 ? (Math.min(...nums) + Math.max(...nums)) / 2 : nums[0];
              }
            }
            return { ...inv, _midpoint: midpoint, _distance: midpoint !== null ? Math.abs(midpoint - searchAmount) : Infinity };
          });

          results.sort((a, b) => {
            if (a._distance !== b._distance) return a._distance - b._distance;
            return (b.followers_count || 0) - (a.followers_count || 0);
          });

          results = results.slice(0, 20).map(({ _midpoint, _distance, ...rest }) => rest);
        }
      }

      results = results.slice(0, 20);
      if (cache) await cache.set(cacheKey, results, 60);
    }

    return res.json({ investors: results });
  } catch (err) {
    console.error('Search investors error:', err);
    return res.status(500).json({ error: 'Failed to search investors' });
  }
});

module.exports = router;
