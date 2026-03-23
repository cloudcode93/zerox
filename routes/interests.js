const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { createAndDeliverNotification } = require('../services/notification_service');

// POST /interest/send
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const supabaseUser = req.supabaseUser;
    const { idea_id, message } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('id, name, role')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get idea founder
    const { data: idea } = await supabase
      .from('ideas')
      .select('user_id')
      .eq('id', idea_id)
      .single();

    if (!idea) return res.status(404).json({ error: 'Idea not found' });

    const founderId = idea.user_id;

    // Check block status
    const { data: blockCheck } = await supabase
      .from('user_blocks')
      .select('id')
      .or(`and(blocker_id.eq.${user.id},blocked_id.eq.${founderId}),and(blocker_id.eq.${founderId},blocked_id.eq.${user.id})`)
      .limit(1);

    if (blockCheck && blockCheck.length > 0) {
      return res.status(403).json({ error: 'Cannot send interest due to block settings' });
    }

    const { data: interest, error } = await supabase
      .from('interests')
      .insert({
        investor_id: user.id,
        idea_id,
        founder_id: idea.user_id,
        message: message || '',
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') { // Unique constraint
        return res.status(409).json({ error: 'Interest already sent' });
      }
      throw error;
    }

    // Notify founder with smart delivery
    await createAndDeliverNotification(supabase, io, onlineUsers, {
      userId: idea.user_id,
      actorId: user.id,
      type: 'interest',
      referenceId: interest.id,
      message: `${user.name} is interested in your idea`,
    });

    return res.json({ interest });
  } catch (err) {
    console.error('Send interest error:', err);
    return res.status(500).json({ error: 'Failed to send interest' });
  }
});

// POST /interest/respond
router.post('/respond', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const supabaseUser = req.supabaseUser;
    const { interest_id, action } = req.body; // action: 'accept' or 'reject'

    const { data: user } = await supabase
      .from('users')
      .select('id, name')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const status = action === 'accept' ? 'accepted' : 'rejected';

    const { data: interest, error } = await supabase
      .from('interests')
      .update({ status })
      .eq('id', interest_id)
      .eq('founder_id', user.id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Interest request not found or already processed.' });
      }
      throw error;
    }

    // Notify investor with smart delivery
    await createAndDeliverNotification(supabase, io, onlineUsers, {
      userId: interest.investor_id,
      actorId: user.id,
      type: action === 'accept' ? 'accept' : 'reject',
      referenceId: interest.idea_id,
      message: `${user.name} ${status} your interest`,
    });

    // Mark the original 'interest' notification for the founder as resolved
    await supabase
      .from('notifications')
      .update({ reference_id: null })
      .eq('user_id', user.id)
      .eq('reference_id', interest_id)
      .eq('type', 'interest');

    // If accepted, create chat and notify investor via socket
    if (action === 'accept') {
      const { data: chat, error: chatError } = await supabase
        .from('chats')
        .insert({
          interest_id: interest.id,
          founder_id: user.id,
          investor_id: interest.investor_id
        })
        .select(`
          *,
          founder:users!chats_founder_id_fkey(id, name, profile_image, role),
          investor:users!chats_investor_id_fkey(id, name, profile_image, role)
        `)
        .single();

      if (chatError && chatError.code !== '23505') throw chatError;

      // Emit chat_created to investor if online so they see it instantly
      if (chat) {
        const investorSocketId = onlineUsers.get(interest.investor_id);
        if (investorSocketId) {
          io.to(investorSocketId).emit('chat_created', {
            ...chat,
            other_user: chat.founder,
          });
          console.log(`[Chat] Emitted chat_created to investor ${interest.investor_id}`);
        }
      }

      return res.json({ interest, chat });
    }

    return res.json({ interest });
  } catch (err) {
    console.error('Respond interest error:', err);
    return res.status(500).json({ error: 'Failed to respond to interest' });
  }
});

// GET /interest/received
router.get('/received', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: interests, error } = await supabase
      .from('interests')
      .select(`
        *,
        investor:users!interests_investor_id_fkey(id, name, profile_image, role),
        idea:ideas!interests_idea_id_fkey(id, problem, category)
      `)
      .eq('founder_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ interests: interests || [] });
  } catch (err) {
    console.error('Get received interests error:', err);
    return res.status(500).json({ error: 'Failed to get interests' });
  }
});

module.exports = router;
