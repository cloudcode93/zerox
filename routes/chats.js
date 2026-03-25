const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { chatLimiter } = require('../middleware/limiters');

// HELPER: Get current user (cached)
async function getCurrentUser(supabase, supabaseUser, cache) {
  if (cache) {
    const cached = await cache.get(`current_user:${supabaseUser.id}`);
    if (cached) return cached;
  }
  const { data: user } = await supabase
    .from('users').select('id').eq('supabase_uid', supabaseUser.id).single();
  if (user && cache) await cache.set(`current_user:${supabaseUser.id}`, user, 120);
  return user;
}

// POST /chat/create
router.post('/create', authMiddleware, chatLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { investor_id } = req.body;

    if (!investor_id) return res.status(400).json({ error: 'investor_id is required' });

    const currentUser = await getCurrentUser(supabase, req.supabaseUser, cache);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const founderId = currentUser.id;

    // Check block status (cached)
    const blockKey = `block:${[founderId, investor_id].sort().join(':')}`;
    let isBlocked = cache ? await cache.get(blockKey) : null;
    if (isBlocked === null) {
      const { data: blockCheck } = await supabase
        .from('user_blocks').select('id')
        .or(`and(blocker_id.eq.${founderId},blocked_id.eq.${investor_id}),and(blocker_id.eq.${investor_id},blocked_id.eq.${founderId})`)
        .limit(1);
      isBlocked = blockCheck && blockCheck.length > 0;
      if (cache) await cache.set(blockKey, isBlocked, 60);
    }

    if (isBlocked) {
      return res.status(403).json({ error: 'This action is not permitted due to block settings' });
    }

    const CHAT_SELECT = `*, founder:users!chats_founder_id_fkey(id, name, profile_image, role),
      investor:users!chats_investor_id_fkey(id, name, profile_image, role)`;

    // Check if chat exists
    const { data: existingChat } = await supabase
      .from('chats').select(CHAT_SELECT)
      .or(`and(founder_id.eq.${founderId},investor_id.eq.${investor_id}),and(founder_id.eq.${investor_id},investor_id.eq.${founderId})`)
      .single();

    if (existingChat) {
      return res.json({ chat: existingChat, existing: true });
    }

    const { data: newChat, error } = await supabase
      .from('chats')
      .insert({ founder_id: founderId, investor_id: investor_id, last_message: '', last_message_at: new Date().toISOString() })
      .select(CHAT_SELECT)
      .single();

    if (error) throw error;

    // Cache chat metadata
    if (cache) {
      await cache.set(`chat:${newChat.id}:meta`, { founder_id: founderId, investor_id: investor_id }, 120);
    }

    return res.json({ chat: newChat, existing: false });
  } catch (err) {
    console.error('Create chat error:', err);
    return res.status(500).json({ error: 'Failed to create chat' });
  }
});

// GET /chat/list
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: chats, error } = await supabase
      .from('chats')
      .select(`*, founder:users!chats_founder_id_fkey(id, name, profile_image, role),
        investor:users!chats_investor_id_fkey(id, name, profile_image, role)`)
      .or(`founder_id.eq.${user.id},investor_id.eq.${user.id}`)
      .order('last_message_at', { ascending: false });

    if (error) throw error;

    // Batch unread count query
    const chatIds = (chats || []).map(c => c.id);
    let unreadCounts = {};
    if (chatIds.length > 0) {
      const { data: unreadMsgs } = await supabase
        .from('messages').select('chat_id')
        .in('chat_id', chatIds).eq('is_read', false).neq('sender_id', user.id);

      if (unreadMsgs) {
        unreadMsgs.forEach(msg => {
          unreadCounts[msg.chat_id] = (unreadCounts[msg.chat_id] || 0) + 1;
        });
      }
    }

    const enrichedChats = (chats || []).map(chat => ({
      ...chat,
      other_user: chat.founder_id === user.id ? chat.investor : chat.founder,
      unread_count: unreadCounts[chat.id] || 0
    }));

    return res.json({ chats: enrichedChats });
  } catch (err) {
    console.error('Get chat list error:', err);
    return res.status(500).json({ error: 'Failed to get chats' });
  }
});

// GET /chat/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const user = await getCurrentUser(supabase, req.supabaseUser, cache);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify participation (cached)
    let chatMeta = cache ? await cache.get(`chat:${id}:meta`) : null;
    if (!chatMeta) {
      const { data: chat } = await supabase
        .from('chats').select('founder_id, investor_id').eq('id', id).single();
      chatMeta = chat;
      if (chatMeta && cache) await cache.set(`chat:${id}:meta`, chatMeta, 120);
    }

    if (!chatMeta) return res.status(404).json({ error: 'Chat not found' });
    if (chatMeta.founder_id !== user.id && chatMeta.investor_id !== user.id) {
      return res.status(403).json({ error: 'Unauthorized: not a participant of this chat' });
    }

    const { data: messages, error } = await supabase
      .from('messages')
      .select(`*, sender:users!messages_sender_id_fkey(id, name, profile_image)`)
      .eq('chat_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Mark as read (fire-and-forget)
    supabase
      .from('messages')
      .update({ is_read: true })
      .eq('chat_id', id)
      .neq('sender_id', user.id)
      .eq('is_read', false)
      .then(() => {})
      .catch(err => console.error('Mark read error:', err.message));

    return res.json({ messages: (messages || []).reverse() });
  } catch (err) {
    console.error('Get chat messages error:', err);
    return res.status(500).json({ error: 'Failed to get messages' });
  }
});

// DELETE /chat/message/:messageId
router.delete('/message/:messageId', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { messageId } = req.params;
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: message } = await supabase
      .from('messages').select('sender_id').eq('id', messageId).single();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.sender_id !== user.id) return res.status(403).json({ error: 'Unauthorized to delete this message' });

    await supabase.from('messages').delete().eq('id', messageId);
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete message error:', err);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
});

// DELETE /chat/:chatId
router.delete('/:chatId', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const { chatId } = req.params;
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify participation (cached)
    let chatMeta = cache ? await cache.get(`chat:${chatId}:meta`) : null;
    if (!chatMeta) {
      const { data: chat } = await supabase
        .from('chats').select('founder_id, investor_id').eq('id', chatId).single();
      chatMeta = chat;
    }

    if (!chatMeta) return res.status(404).json({ error: 'Chat not found' });
    if (chatMeta.founder_id !== user.id && chatMeta.investor_id !== user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await supabase.from('messages').delete().eq('chat_id', chatId);
    await supabase.from('chats').delete().eq('id', chatId);

    // Invalidate chat cache
    if (cache) await cache.invalidate(`chat:${chatId}:meta`);

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete chat error:', err);
    return res.status(500).json({ error: 'Failed to delete chat' });
  }
});

module.exports = router;
