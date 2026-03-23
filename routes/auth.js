const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// POST /auth/sync-user - Sync user after Google OAuth login
router.post('/sync-user', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;

    const { name, email, profile_image } = req.body;

    // Check if user exists
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (existing) {
      // Update profile image from Google
      const { data: updated, error } = await supabase
        .from('users')
        .update({ profile_image: profile_image || existing.profile_image })
        .eq('supabase_uid', supabaseUser.id)
        .select()
        .single();

      if (error) throw error;
      return res.json({ user: updated, isNewUser: false });
    }

    // Create new user
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        supabase_uid: supabaseUser.id,
        name: name || supabaseUser.user_metadata?.full_name || 'User',
        email: email || supabaseUser.email,
        profile_image: profile_image || supabaseUser.user_metadata?.avatar_url || ''
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ user: newUser, isNewUser: true });
  } catch (err) {
    console.error('Sync user error:', err);
    return res.status(500).json({ error: 'Failed to sync user' });
  }
});

module.exports = router;
