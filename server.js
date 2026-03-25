require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// ── Infrastructure Services ──
const redisService = require('./services/redis');
const cache = require('./services/cache');
const queueService = require('./services/queue');
const workerService = require('./workers/worker');

const app = express();
const server = http.createServer(app);

const INSTANCE_ID = process.env.RENDER_SERVICE_ID || process.env.INSTANCE_ID || `instance-${process.pid}`;
console.log(`[Server] Starting instance: ${INSTANCE_ID}`);

// ── CORS Configuration ──
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  },
  // Performance: limit payload, enable binary parser
  maxHttpBufferSize: 1e6, // 1MB max per Socket.IO message
  pingTimeout: 30000,
  pingInterval: 15000,
});

// ── Security & Performance Middleware ──
app.use(helmet());
app.use(compression()); // gzip responses
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '200kb' })); // tightened from 500kb
app.use(morgan('short')); // structured HTTP logging

// Request timeout (30 seconds)
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

// Apply general rate limit globally
const { generalLimiter } = require('./middleware/limiters');
app.use(generalLimiter);

// ── Supabase client (service role for backend operations) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// ── Initialize Firebase Admin SDK ──
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
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
    console.warn('⚠️  Firebase credentials not found — push notifications disabled');
  }
}

// ── Initialize Redis + Socket.IO Adapter + Queues + Workers ──
redisService.init();

const redisPub = redisService.getPub();
const redisSub = redisService.getSub();
if (redisPub && redisSub) {
  const { createAdapter } = require('@socket.io/redis-adapter');
  io.adapter(createAdapter(redisPub, redisSub));
  console.log('[Server] Socket.IO Redis adapter attached — events sync across all instances');
}

const redisClient = redisService.getRedis();
if (redisClient) {
  queueService.init(redisClient);
  workerService.init(redisClient, supabase);
}

// ── Online Users: Redis hash (shared) with local fallback ──
const localOnlineUsers = new Map(); // fallback if Redis is down

async function setUserOnline(userId, socketId) {
  localOnlineUsers.set(userId, socketId);
  try {
    const redis = redisService.getRedis();
    if (redis && redisService.getIsConnected()) {
      await redis.hset('online_users', userId, socketId);
    }
  } catch (err) { /* silent */ }
}

async function removeUserOnline(userId) {
  localOnlineUsers.delete(userId);
  try {
    const redis = redisService.getRedis();
    if (redis && redisService.getIsConnected()) {
      await redis.hdel('online_users', userId);
    }
  } catch (err) { /* silent */ }
}

async function isUserOnline(userId) {
  try {
    const redis = redisService.getRedis();
    if (redis && redisService.getIsConnected()) {
      const sid = await redis.hget('online_users', userId);
      return !!sid;
    }
  } catch (err) { /* silent */ }
  return localOnlineUsers.has(userId);
}

async function getOnlineUserCount() {
  try {
    const redis = redisService.getRedis();
    if (redis && redisService.getIsConnected()) {
      return await redis.hlen('online_users');
    }
  } catch (err) { /* silent */ }
  return localOnlineUsers.size;
}

// ── Make services available to routes ──
app.set('supabase', supabase);
app.set('io', io);
app.set('cache', cache);
app.set('queue', queueService);
app.set('isUserOnline', isUserOnline);
app.set('onlineUsers', localOnlineUsers); // backward compat for notification_service

// ── Routes ──
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
  res.json({
    status: 'ok',
    instance: INSTANCE_ID,
    redis: redisService.getIsConnected(),
    cache: cache.stats(),
  });
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

    // Look up the app-level user ID (cached)
    let dbUser = await cache.get(`uid_map:${user.id}`);
    if (!dbUser) {
      const { data } = await supabase
        .from('users')
        .select('id, is_banned')
        .eq('supabase_uid', user.id)
        .single();
      dbUser = data;
      if (dbUser) {
        await cache.set(`uid_map:${user.id}`, dbUser, 120);
      }
    }

    if (!dbUser) return next(new Error('User not found'));
    if (dbUser.is_banned) return next(new Error('Account is banned'));

    socket.userId = dbUser.id;
    socket.supabaseUid = user.id;
    next();
  } catch (err) {
    console.error('Socket auth error:', err.message);
    next(new Error('Authentication failed'));
  }
});

// ── Socket.IO Connection Handling ──
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id} | user: ${socket.userId}`);

  // Register user as online
  if (socket.userId) {
    setUserOnline(socket.userId, socket.id);
  }

  socket.on('user_online', () => {
    if (socket.userId) {
      setUserOnline(socket.userId, socket.id);
    }
  });

  socket.on('join_chat', async ({ chatId }) => {
    // Verify user is a participant (cached)
    let chatMeta = await cache.get(`chat:${chatId}:meta`);
    if (!chatMeta) {
      const { data: chat } = await supabase
        .from('chats')
        .select('founder_id, investor_id')
        .eq('id', chatId)
        .single();
      chatMeta = chat;
      if (chatMeta) {
        await cache.set(`chat:${chatId}:meta`, chatMeta, 120);
      }
    }

    if (!chatMeta || (chatMeta.founder_id !== socket.userId && chatMeta.investor_id !== socket.userId)) {
      socket.emit('error', { message: 'Unauthorized: not a chat participant' });
      return;
    }

    socket.join(`chat_${chatId}`);
  });

  // Anti-spam
  const messageTimestamps = new Map();

  socket.on('send_message', async ({ chatId, message }) => {
    const senderId = socket.userId;
    try {
      // Rate limit: 1 msg/sec
      const now = Date.now();
      const lastMsgTime = messageTimestamps.get(senderId);
      if (lastMsgTime && now - lastMsgTime < 1000) {
        socket.emit('error', { message: 'Sending messages too fast.' });
        return;
      }
      messageTimestamps.set(senderId, now);

      // Get chat metadata (cached)
      let chatData = await cache.get(`chat:${chatId}:meta`);
      if (!chatData) {
        const { data } = await supabase.from('chats').select('founder_id, investor_id').eq('id', chatId).single();
        chatData = data;
        if (chatData) await cache.set(`chat:${chatId}:meta`, chatData, 120);
      }

      if (!chatData) {
        socket.emit('error', { message: 'Chat not found' });
        return;
      }

      const recipientId = chatData.founder_id === senderId ? chatData.investor_id : chatData.founder_id;

      // Check block status (cached)
      const blockKey = `block:${[senderId, recipientId].sort().join(':')}`;
      let isBlocked = await cache.get(blockKey);
      if (isBlocked === null) {
        const { data: blockCheck } = await supabase
          .from('user_blocks')
          .select('id')
          .or(`and(blocker_id.eq.${senderId},blocked_id.eq.${recipientId}),and(blocker_id.eq.${recipientId},blocked_id.eq.${senderId})`)
          .limit(1);
        isBlocked = blockCheck && blockCheck.length > 0;
        await cache.set(blockKey, isBlocked, 60);
      }

      if (isBlocked) {
        socket.emit('error', { message: 'Message cannot be sent due to block settings' });
        return;
      }

      // Store message in database (only DB call that MUST happen)
      const { data, error } = await supabase
        .from('messages')
        .insert({ chat_id: chatId, sender_id: senderId, message: message })
        .select(`*, sender:users!messages_sender_id_fkey(id, name, profile_image)`)
        .single();

      if (error) throw error;

      // Update chat last message (fire-and-forget)
      supabase
        .from('chats')
        .update({ last_message: message, last_message_at: new Date().toISOString() })
        .eq('id', chatId)
        .then(() => {})
        .catch(err => console.error('[Chat] Update last_message error:', err.message));

      // Emit to room (synced across all instances via Redis adapter)
      io.to(`chat_${chatId}`).emit('receive_message', data);

      // Queue push notification (async — doesn't block response)
      const notifQueue = queueService.getNotificationQueue();
      if (notifQueue) {
        const senderName = data.sender?.name || 'Someone';
        await notifQueue.add('chat_push', {
          type: 'fcm_push',
          data: {
            userId: recipientId,
            title: senderName,
            body: message.length > 100 ? message.substring(0, 100) + '...' : message,
            payload: { type: 'chat_message', chat_id: chatId },
          },
        }, { removeOnComplete: true, removeOnFail: 50 });
      } else {
        // Inline fallback if queue is unavailable
        try {
          const { sendChatPushNotification } = require('./services/notification_service');
          await sendChatPushNotification(supabase, io, localOnlineUsers, {
            recipientId,
            senderName: data.sender?.name || 'Someone',
            messageText: message.length > 100 ? message.substring(0, 100) + '...' : message,
            chatId,
          });
        } catch (pushErr) {
          console.error('Chat push fallback error:', pushErr.message);
        }
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
    if (socket.userId) {
      removeUserOnline(socket.userId);
    }
    console.log(`[Socket] Disconnected: ${socket.id} | user: ${socket.userId}`);
  });
});

// ── Cron Jobs ──
require('./cron')(supabase, { getOnlineUserCount, isUserOnline }, queueService, cache, INSTANCE_ID);

// ── Graceful Shutdown ──
async function gracefulShutdown(signal) {
  console.log(`[Server] ${signal} received — shutting down gracefully...`);
  server.close(async () => {
    await workerService.shutdown();
    await redisService.shutdown();
    console.log('[Server] Shutdown complete');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Start ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Zerox server running on port ${PORT} | instance: ${INSTANCE_ID}`);
});
