require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// ── CORS Configuration ──
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// ── Security Middleware ──
app.use(helmet());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '500kb' }));

// Apply general rate limit globally
const { generalLimiter } = require('./middleware/limiters');
app.use(generalLimiter);

// Supabase client (service role for backend operations)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Initialize Firebase Admin SDK
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Handle escaped newline characters in the private key string from .env
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log('Firebase Admin SDK initialized via Environment Variables');
  } catch (err) {
    console.error('Failed to initialize Firebase Admin via Env Vars:', err.message);
  }
} else {
  const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
  if (fs.existsSync(serviceAccountPath)) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(require(serviceAccountPath)),
      });
      console.log('Firebase Admin SDK initialized via JSON file');
    } catch (err) {
      console.error('Failed to initialize Firebase Admin via JSON file:', err.message);
    }
  } else {
    console.warn('⚠️  Firebase credentials not found (env vars or json file) — push notifications disabled');
  }
}

// Online users tracking (shared with routes)
const onlineUsers = new Map();

// Make supabase, io, and onlineUsers available to routes
app.set('supabase', supabase);
app.set('io', io);
app.set('onlineUsers', onlineUsers);

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/user', require('./routes/users'));
app.use('/ideas', require('./routes/ideas'));
app.use('/like', require('./routes/likes'));
app.use('/comment', require('./routes/comments'));
app.use('/follow', require('./routes/follows'));
app.use('/interest', require('./routes/interests'));
app.use('/chat', require('./routes/chats'));
app.use('/notifications', require('./routes/notifications'));
app.use('/admin', require('./routes/admin'));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Zerox API is running' });
});

// ── Socket.IO Authentication Middleware ──
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    // Verify token with Supabase
    const verifyClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );
    const { data: { user }, error } = await verifyClient.auth.getUser(token);

    if (error || !user) {
      return next(new Error('Invalid or expired token'));
    }

    // Look up the app-level user ID
    const { data: dbUser } = await supabase
      .from('users')
      .select('id, is_banned')
      .eq('supabase_uid', user.id)
      .single();

    if (!dbUser) return next(new Error('User not found'));
    if (dbUser.is_banned) return next(new Error('Account is banned'));

    // Attach verified user data to socket
    socket.userId = dbUser.id;
    socket.supabaseUid = user.id;
    next();
  } catch (err) {
    console.error('Socket auth error:', err.message);
    next(new Error('Authentication failed'));
  }
});

// Socket.io handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id, '| userId:', socket.userId);

  // Register user as online using verified ID
  if (socket.userId) {
    onlineUsers.set(socket.userId, socket.id);
  }

  socket.on('user_online', () => {
    // userId already set from auth middleware; just re-register
    if (socket.userId) {
      onlineUsers.set(socket.userId, socket.id);
    }
  });

  socket.on('join_chat', async ({ chatId }) => {
    // Verify user is a participant of this chat
    const { data: chat } = await supabase
      .from('chats')
      .select('founder_id, investor_id')
      .eq('id', chatId)
      .single();

    if (!chat || (chat.founder_id !== socket.userId && chat.investor_id !== socket.userId)) {
      socket.emit('error', { message: 'Unauthorized: not a chat participant' });
      return;
    }

    socket.join(`chat_${chatId}`);
    console.log(`User ${socket.userId} joined chat ${chatId}`);
  });

  // Anti-spam configuration for messages
  const messageTimestamps = new Map();

  socket.on('send_message', async ({ chatId, message }) => {
    const senderId = socket.userId; // Use verified ID, never trust client
    try {
      // Basic rate limit: 1 message per second max
      const now = Date.now();
      const lastMsgTime = messageTimestamps.get(senderId);
      if (lastMsgTime && now - lastMsgTime < 1000) {
        socket.emit('error', { message: 'Sending messages too fast. Please slow down.' });
        return;
      }
      messageTimestamps.set(senderId, now);

      // Check block status before sending message
      const { data: chatData } = await supabase.from('chats').select('founder_id, investor_id').eq('id', chatId).single();
      if (!chatData) {
        socket.emit('error', { message: 'Chat not found' });
        return;
      }
      
      const recipientId = chatData.founder_id === senderId ? chatData.investor_id : chatData.founder_id;
      
      const { data: blockCheck } = await supabase
        .from('user_blocks')
        .select('id')
        .or(`and(blocker_id.eq.${senderId},blocked_id.eq.${recipientId}),and(blocker_id.eq.${recipientId},blocked_id.eq.${senderId})`)
        .limit(1);

      if (blockCheck && blockCheck.length > 0) {
        socket.emit('error', { message: 'Message cannot be sent due to block settings' });
        return;
      }

      // Store message in database
      const { data, error } = await supabase
        .from('messages')
        .insert({
          chat_id: chatId,
          sender_id: senderId,
          message: message
        })
        .select(`
          *,
          sender:users!messages_sender_id_fkey(id, name, profile_image)
        `)
        .single();

      if (error) throw error;

      // Update chat last message
      await supabase
        .from('chats')
        .update({
          last_message: message,
          last_message_at: new Date().toISOString()
        })
        .eq('id', chatId);

      // Emit to room
      io.to(`chat_${chatId}`).emit('receive_message', data);

      // Send push notification to offline chat participant
      try {
        const { sendChatPushNotification } = require('./services/notification_service');
        const { data: chat } = await supabase.from('chats').select('founder_id, investor_id').eq('id', chatId).single();
        if (chat) {
          const recipientId = chat.founder_id === senderId ? chat.investor_id : chat.founder_id;
          const senderName = data.sender?.name || 'Someone';
          await sendChatPushNotification(supabase, io, onlineUsers, {
            recipientId,
            senderName,
            messageText: message.length > 100 ? message.substring(0, 100) + '...' : message,
            chatId,
          });
        }
      } catch (pushErr) {
        console.error('Chat push notification error:', pushErr);
      }
    } catch (err) {
      console.error('Send message error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('typing', ({ chatId, userId }) => {
    socket.to(`chat_${chatId}`).emit('user_typing', { userId });
  });

  socket.on('stop_typing', ({ chatId, userId }) => {
    socket.to(`chat_${chatId}`).emit('user_stop_typing', { userId });
  });

  socket.on('disconnect', () => {
    // Remove user from online users using verified ID
    if (socket.userId && onlineUsers.get(socket.userId) === socket.id) {
      onlineUsers.delete(socket.userId);
    }
    console.log('User disconnected:', socket.id, '| userId:', socket.userId);
  });
});

// Init optimization cron jobs
require('./cron')(supabase, onlineUsers);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Zerox server running on port ${PORT}`);
});
