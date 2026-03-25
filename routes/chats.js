'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { chatLimiter } = require('../middleware/limiters');
const logger = require('../config/logger');

// POST /chat/create - Create or get existing chat between two users
router.post('/create', authMiddleware, chatLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;
    const { investor_id } = req.body;

    if (!investor_id) return res.status(400).json({ error: 'investor_id is required' });

    // Get current user (founder)
    const { data: currentUser } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const founderId = currentUser.id;

    // Check block status
    const { data: blockCheck } = await supabase
      .from('user_blocks')
      .select('id')
      .or(`and(blocker_id.eq.${founderId},blocked_id.eq.${investor_id}),and(blocker_id.eq.${investor_id},blocked_id.eq.${founderId})`)
      .limit(1);

    if (blockCheck && blockCheck.length > 0) {
      return res.status(403).json({ error: 'This action is not permitted due to block settings' });
    }

    // Check if chat already exists between these two users (in either direction)
    const { data: existingChat } = await supabase
      .from('chats')
      .select(`
        *,
        founder:users!chats_founder_id_fkey(id, name, profile_image, role),
        investor:users!chats_investor_id_fkey(id, name, profile_image, role)
      `)
      .or(`and(founder_id.eq.${founderId},investor_id.eq.${investor_id}),and(founder_id.eq.${investor_id},investor_id.eq.${founderId})`)
      .single();

    if (existingChat) {
      return res.json({ chat: existingChat, existing: true });
    }

    // Create new chat
    const { data: newChat, error } = await supabase
      .from('chats')
      .insert({
        founder_id: founderId,
        investor_id: investor_id,
        last_message: '',
        last_message_at: new Date().toISOString()
      })
      .select(`
        *,
        founder:users!chats_founder_id_fkey(id, name, profile_image, role),
        investor:users!chats_investor_id_fkey(id, name, profile_image, role)
      `)
      .single();

    if (error) throw error;
    return res.json({ chat: newChat, existing: false });
  } catch (err) {
    logger.error('Create chat error:', err);
    return res.status(500).json({ error: 'Failed to create chat' });
  }
});

// GET /chat/list
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: chats, error } = await supabase
      .from('chats')
      .select(`
        *,
        founder:users!chats_founder_id_fkey(id, name, profile_image, role),
        investor:users!chats_investor_id_fkey(id, name, profile_image, role)
      `)
      .or(`founder_id.eq.${user.id},investor_id.eq.${user.id}`)
      .order('last_message_at', { ascending: false });

    if (error) throw error;

    // Fetch unread messages for these chats
    const chatIds = chats.map(c => c.id);
    let unreadCounts = {};
    if (chatIds.length > 0) {
      const { data: unreadMsgs } = await supabase
        .from('messages')
        .select('chat_id')
        .in('chat_id', chatIds)
        .eq('is_read', false)
        .neq('sender_id', user.id);
        
      if (unreadMsgs) {
        unreadMsgs.forEach(msg => {
          unreadCounts[msg.chat_id] = (unreadCounts[msg.chat_id] || 0) + 1;
        });
      }
    }

    // Add other_user field and unread_count
    const enrichedChats = (chats || []).map(chat => ({
      ...chat,
      other_user: chat.founder_id === user.id ? chat.investor : chat.founder,
      unread_count: unreadCounts[chat.id] || 0
    }));

    return res.json({ chats: enrichedChats });
  } catch (err) {
    logger.error('Get chat list error:', err);
    return res.status(500).json({ error: 'Failed to get chats' });
  }
});

// GET /chat/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const supabaseUser = req.supabaseUser;
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify user is a participant of this chat
    const { data: chat } = await supabase
      .from('chats')
      .select('founder_id, investor_id')
      .eq('id', id)
      .single();

    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.founder_id !== user.id && chat.investor_id !== user.id) {
      return res.status(403).json({ error: 'Unauthorized: not a participant of this chat' });
    }

    const { data: messages, error } = await supabase
      .from('messages')
      .select(`
        *,
        sender:users!messages_sender_id_fkey(id, name, profile_image)
      `)
      .eq('chat_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Mark messages as read
    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('chat_id', id)
      .neq('sender_id', user.id)
      .eq('is_read', false);

    return res.json({ messages: (messages || []).reverse() });
  } catch (err) {
    logger.error('Get chat messages error:', err);
    return res.status(500).json({ error: 'Failed to get messages' });
  }
});

// DELETE /chat/message/:messageId
router.delete('/message/:messageId', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { messageId } = req.params;
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify ownership
    const { data: message } = await supabase
      .from('messages')
      .select('sender_id')
      .eq('id', messageId)
      .single();

    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.sender_id !== user.id) return res.status(403).json({ error: 'Unauthorized to delete this message' });

    await supabase.from('messages').delete().eq('id', messageId);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Delete message error:', err);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
});

// DELETE /chat/:chatId — Delete entire chat conversation
router.delete('/:chatId', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { chatId } = req.params;
    const supabaseUser = req.supabaseUser;

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_uid', supabaseUser.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify user is a participant
    const { data: chat } = await supabase
      .from('chats')
      .select('founder_id, investor_id')
      .eq('id', chatId)
      .single();

    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.founder_id !== user.id && chat.investor_id !== user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Delete all messages in this chat first
    await supabase.from('messages').delete().eq('chat_id', chatId);

    // Delete the chat
    await supabase.from('chats').delete().eq('id', chatId);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Delete chat error:', err);
    return res.status(500).json({ error: 'Failed to delete chat' });
  }
});

module.exports = router;
