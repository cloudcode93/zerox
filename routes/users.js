const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { authLimiter } = require('../middleware/limiters');

// GET /user/:id - Get user profile
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { id } = req.params;
    const currentUserId = req.supabaseUser.id;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, supabase_uid, name, email, profile_image, role, bio, location, website, linkedin_url, investment_range, ideas_count, followers_count, following_count, is_admin, is_banned')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.is_banned === true) {
      return res.json({
        user: {
          id: user.id,
          name: user.name,
          profile_image: user.profile_image,
          is_banned: true,
          is_following: false,
          has_blocked: false,
          is_blocked: false
        }
      });
    }

    // Check if current user follows or blocks this user
    const { data: currentUser } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', currentUserId)
      .single();

    let isFollowing = false;
    let hasBlocked = false;
    let isBlocked = false;

    if (currentUser) {
      // Check follow
      const { data: follow } = await supabase
        .from('follows')
        .select('id')
        .eq('follower_id', currentUser.id)
        .eq('following_id', id)
        .single();
      isFollowing = !!follow;

      // Check if current user blocked the target
      const { data: blockOut } = await supabase
        .from('user_blocks')
        .select('id')
        .eq('blocker_id', currentUser.id)
        .eq('blocked_id', id)
        .single();
      hasBlocked = !!blockOut;

      // Check if target blocked the current user
      const { data: blockIn } = await supabase
        .from('user_blocks')
        .select('id')
        .eq('blocker_id', id)
        .eq('blocked_id', currentUser.id)
        .single();
      isBlocked = !!blockIn;
    }

    return res.json({ user: { ...user, is_following: isFollowing, has_blocked: hasBlocked, is_blocked: isBlocked } });
  } catch (err) {
    console.error('Get user error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /user/block - Block a user
router.post('/block', authMiddleware, authLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { target_id } = req.body;
    const currentUserId = req.supabaseUser.id;

    const { data: currentUser } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', currentUserId)
      .single();

    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    if (currentUser.id === target_id) return res.status(400).json({ error: 'You cannot block yourself' });

    // Insert block record
    const { error: blockError } = await supabase
      .from('user_blocks')
      .insert({ blocker_id: currentUser.id, blocked_id: target_id });

    if (blockError && blockError.code !== '23505') { // ignore unique violation (already blocked)
      throw blockError;
    }

    // Force unfollow in both directions
    await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', target_id);
    await supabase.from('follows').delete().eq('follower_id', target_id).eq('following_id', currentUser.id);

    return res.json({ success: true, message: 'User blocked successfully' });
  } catch (err) {
    console.error('Block user error:', err);
    return res.status(500).json({ error: 'Failed to block user' });
  }
});

// POST /user/unblock - Unblock a user
router.post('/unblock', authMiddleware, authLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { target_id } = req.body;
    const currentUserId = req.supabaseUser.id;

    const { data: currentUser } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', currentUserId)
      .single();

    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const { error } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blocker_id', currentUser.id)
      .eq('blocked_id', target_id);

    if (error) throw error;
    return res.json({ success: true, message: 'User unblocked successfully' });
  } catch (err) {
    console.error('Unblock user error:', err);
    return res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// GET /user/blocks - Get list of blocked users
router.get('/blocks/list', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const currentUserId = req.supabaseUser.id;

    const { data: currentUser } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', currentUserId)
      .single();

    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const { data: blocks, error } = await supabase
      .from('user_blocks')
      .select(`
        id,
        blocked_user:blocked_id (id, name, profile_image, role, bio)
      `)
      .eq('blocker_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Flatten logic
    const results = blocks ? blocks.map(b => ({
      block_id: b.id,
      ...b.blocked_user
    })) : [];

    return res.json({ users: results });
  } catch (err) {
    console.error('Get blocked users error:', err);
    return res.status(500).json({ error: 'Failed to list blocked users' });
  }
});

// GET /user/by-uid/:uid - Get user by Supabase UID
router.get('/by-uid/:uid', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { uid } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, supabase_uid, name, email, profile_image, role, bio, location, website, linkedin_url, investment_range, ideas_count, followers_count, following_count, is_admin, is_banned')
      .eq('supabase_uid', uid)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.is_banned === true) {
      return res.json({
        user: {
          id: user.id,
          name: user.name,
          profile_image: user.profile_image,
          is_banned: true,
        }
      });
    }

    return res.json({ user });
  } catch (err) {
    console.error('Get user by uid error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// PUT /user/update - Update user profile
router.put('/update', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;
    const { name, bio, role, linkedin_url, website, location, investment_range } = req.body;

    // Validate role if provided
    const ALLOWED_ROLES = ['founder', 'investor'];
    if (role !== undefined && !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${ALLOWED_ROLES.join(', ')}` });
    }

    // Enforce length limits
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
    return res.json({ user });
  } catch (err) {
    console.error('Update user error:', err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// GET /user/popular - Get popular creators
router.get('/popular/list', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, profile_image, role, followers_count')
      .eq('is_banned', false)
      .order('followers_count', { ascending: false })
      .limit(10);

    if (error) throw error;
    return res.json({ users: users || [] });
  } catch (err) {
    console.error('Popular users error:', err);
    return res.status(500).json({ error: 'Failed to fetch popular users' });
  }
});
// GET /user/search/investors - Search investors by investment range
router.get('/search/investors', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { amount, name } = req.query;

    let query = supabase
      .from('users')
      .select('id, name, profile_image, role, bio, investment_range, followers_count, location')
      .eq('role', 'investor')
      .eq('is_banned', false)
      .order('followers_count', { ascending: false })
      .limit(50);

    if (name) {
      query = query.ilike('name', `%${name}%`);
    }

    const { data: investors, error } = await query;
    if (error) throw error;

    let results = investors || [];

    // Sort by proximity to searched amount
    if (amount) {
      const searchAmount = parseInt(amount);
      if (!isNaN(searchAmount)) {
        // Parse each investor's range into a representative number
        results = results.map(inv => {
          let midpoint = null;
          if (inv.investment_range) {
            const range = inv.investment_range.replace(/[,$₹€£\s]/g, '').trim();
            const numbers = range.match(/\d+/g);
            if (numbers && numbers.length > 0) {
              let nums = numbers.map(n => parseInt(n));
              // Handle "k" suffix
              nums = nums.map(n => n < 1000 && range.toLowerCase().includes('k') ? n * 1000 : n);
              midpoint = nums.length >= 2 
                ? (Math.min(...nums) + Math.max(...nums)) / 2 
                : nums[0];
            }
          }
          return { ...inv, _midpoint: midpoint, _distance: midpoint !== null ? Math.abs(midpoint - searchAmount) : Infinity };
        });

        // Sort by distance (closest first), then by followers
        results.sort((a, b) => {
          if (a._distance !== b._distance) return a._distance - b._distance;
          return (b.followers_count || 0) - (a.followers_count || 0);
        });

        // Remove internal fields and limit
        results = results.slice(0, 20).map(({ _midpoint, _distance, ...rest }) => rest);
      }
    }

    return res.json({ investors: results.slice(0, 20) });
  } catch (err) {
    console.error('Search investors error:', err);
    return res.status(500).json({ error: 'Failed to search investors' });
  }
});

module.exports = router;
