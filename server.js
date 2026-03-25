'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

// ── Core infrastructure ──
const logger = require('./config/logger');
const supabase = require('./config/supabase');
const { initFirebase } = require('./config/firebase');
const { getRedis, closeRedis } = require('./config/redis');
const { scheduleRepeatableJobs, closeQueues } = require('./queues/queues');
const { startNotificationWorker, stopNotificationWorker } = require('./workers/notificationWorker');
const { startCleanupWorker, stopCleanupWorker } = require('./workers/cleanupWorker');
const errorHandler = require('./middleware/errorHandler');

// ── Initialize Firebase ──
initFirebase();

// ── Express App ──
const app = express();
const server = http.createServer(app);

// ── CORS Configuration ──
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Security & Performance Middleware ──
app.use(helmet());
app.use(compression());   // Gzip responses — reduces bandwidth 60-80%
app.use(cors({ origin: allowedOrigins.includes('*') ? '*' : allowedOrigins }));
app.use(express.json({ limit: '500kb' }));

// ── Request Logging (Morgan → Winston) ──
app.use(morgan(
  ':method :url :status :res[content-length] - :response-time ms',
  { stream: logger.morganStream }
));

// ── Rate Limiting (Redis-backed) ──
const { generalLimiter } = require('./middleware/limiters');
app.use(generalLimiter);

// ── Online Users (Redis Hash) ──
// Replaces in-memory Map — survives restarts, supports multi-instance
const onlineUsers = {
  async set(userId, socketId) {
    try {
      const redis = getRedis();
      await redis.hset('zerox:online_users', userId, socketId);
    } catch (err) {
      logger.error('[OnlineUsers] SET error:', err.message);
    }
  },
  async get(userId) {
    try {
      const redis = getRedis();
      return await redis.hget('zerox:online_users', userId);
    } catch (err) {
      logger.error('[OnlineUsers] GET error:', err.message);
      return null;
    }
  },
  async delete(userId) {
    try {
      const redis = getRedis();
      await redis.hdel('zerox:online_users', userId);
    } catch (err) {
      logger.error('[OnlineUsers] DEL error:', err.message);
    }
  },
  async getAll() {
    try {
      const redis = getRedis();
      return await redis.hgetall('zerox:online_users');
    } catch (err) {
      logger.error('[OnlineUsers] GETALL error:', err.message);
      return {};
    }
  },
  async size() {
    try {
      const redis = getRedis();
      return await redis.hlen('zerox:online_users');
    } catch (err) {
      logger.error('[OnlineUsers] SIZE error:', err.message);
      return 0;
    }
  },
  async keys() {
    try {
      const redis = getRedis();
      return await redis.hkeys('zerox:online_users');
    } catch (err) {
      logger.error('[OnlineUsers] KEYS error:', err.message);
      return [];
    }
  },
};

// ── Make services available to routes ──
app.set('supabase', supabase);
app.set('io', io);
app.set('onlineUsers', onlineUsers);

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

// ── Health Check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Zerox API is running', uptime: Math.floor(process.uptime()) });
});

// ── Global Error Handler (must be last) ──
app.use(errorHandler);

// ════════════════════════════════════════════════════════════
// Socket.IO
// ════════════════════════════════════════════════════════════

// ── Authentication Middleware ──
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    const verifyClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );
    const { data: { user }, error } = await verifyClient.auth.getUser(token);

    if (error || !user) return next(new Error('Invalid or expired token'));

    const { data: dbUser } = await supabase
      .from('users')
      .select('id, is_banned')
      .eq('supabase_uid', user.id)
      .single();

    if (!dbUser) return next(new Error('User not found'));
    if (dbUser.is_banned) return next(new Error('Account is banned'));

    socket.userId = dbUser.id;
    socket.supabaseUid = user.id;
    next();
  } catch (err) {
    logger.error('Socket auth error:', err.message);
    next(new Error('Authentication failed'));
  }
});

// ── Connection Handler ──
io.on('connection', (socket) => {
  logger.info(`Socket connected: ${socket.id} | user: ${socket.userId}`);

  if (socket.userId) {
    onlineUsers.set(socket.userId, socket.id);
  }

  socket.on('user_online', () => {
    if (socket.userId) onlineUsers.set(socket.userId, socket.id);
  });

  socket.on('join_chat', async ({ chatId }) => {
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
    logger.debug(`User ${socket.userId} joined chat ${chatId}`);
  });

  // Anti-spam: 1 message per second per user
  const messageTimestamps = new Map();

  socket.on('send_message', async ({ chatId, message }) => {
    const senderId = socket.userId;
    try {
      const now = Date.now();
      const lastMsgTime = messageTimestamps.get(senderId);
      if (lastMsgTime && now - lastMsgTime < 1000) {
        socket.emit('error', { message: 'Sending messages too fast. Please slow down.' });
        return;
      }
      messageTimestamps.set(senderId, now);

      // Block check
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

      // Store message
      const { data, error } = await supabase
        .from('messages')
        .insert({ chat_id: chatId, sender_id: senderId, message })
        .select('*, sender:users!messages_sender_id_fkey(id, name, profile_image)')
        .single();

      if (error) throw error;

      // Update chat last message
      await supabase
        .from('chats')
        .update({ last_message: message, last_message_at: new Date().toISOString() })
        .eq('id', chatId);

      // Emit to room
      io.to(`chat_${chatId}`).emit('receive_message', data);

      // Queue push notification for offline recipient
      try {
        const { sendChatPushNotification } = require('./services/notification_service');
        const senderName = data.sender?.name || 'Someone';
        await sendChatPushNotification(supabase, io, onlineUsers, {
          recipientId,
          senderName,
          messageText: message.length > 100 ? message.substring(0, 100) + '...' : message,
          chatId,
        });
      } catch (pushErr) {
        logger.error('Chat push notification error:', pushErr.message);
      }
    } catch (err) {
      logger.error('Send message error:', err.message);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('typing', ({ chatId, userId }) => {
    socket.to(`chat_${chatId}`).emit('user_typing', { userId });
  });

  socket.on('stop_typing', ({ chatId, userId }) => {
    socket.to(`chat_${chatId}`).emit('user_stop_typing', { userId });
  });

  socket.on('disconnect', async () => {
    if (socket.userId) {
      const currentSocketId = await onlineUsers.get(socket.userId);
      if (currentSocketId === socket.id) {
        await onlineUsers.delete(socket.userId);
      }
    }
    logger.info(`Socket disconnected: ${socket.id} | user: ${socket.userId}`);
  });
});

// ════════════════════════════════════════════════════════════
// Startup
// ════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Initialize Redis connection
    getRedis();

    // Start BullMQ workers
    startNotificationWorker();
    startCleanupWorker();

    // Schedule repeatable jobs (replaces node-cron)
    await scheduleRepeatableJobs();

    server.listen(PORT, () => {
      logger.info(`Zerox server running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════
// Graceful Shutdown
// ════════════════════════════════════════════════════════════

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`[Shutdown] Received ${signal}, shutting down gracefully...`);

  // 1. Stop accepting new connections
  server.close(() => {
    logger.info('[Shutdown] HTTP server closed');
  });

  // 2. Close Socket.IO connections
  io.close(() => {
    logger.info('[Shutdown] Socket.IO closed');
  });

  // 3. Stop workers (let in-flight jobs finish)
  await stopNotificationWorker();
  await stopCleanupWorker();

  // 4. Close queues
  await closeQueues();

  // 5. Close Redis
  await closeRedis();

  logger.info('[Shutdown] Cleanup complete, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Catch unhandled errors (prevent crash) ──
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', { reason: reason?.message || reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
  // Give time for log flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

start();
