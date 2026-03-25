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
const { sendChatPushNotification } = require('./services/notification_service');
const errorHandler = require('./middleware/errorHandler');
const { loadSheddingMiddleware } = require('./middleware/loadShedding');

// ── Initialize Firebase ──
initFirebase();

// ── Express App ──
const app = express();
const server = http.createServer(app);

// ── Server-Level Timeouts ──
server.timeout = 30000;           // 30s max per connection
server.keepAliveTimeout = 65000;  // Must be > ALB's idle timeout (60s)
server.headersTimeout = 66000;    // Must be > keepAliveTimeout

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
  maxHttpBufferSize: 64 * 1024,    // 64KB max message size
  connectTimeout: 10000,           // 10s connection timeout
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

// ── Load Shedding (MUST be before rate limiters and routes) ──
app.use(loadSheddingMiddleware);

// ── Rate Limiting ──
const { generalLimiter, spamLimiter } = require('./middleware/limiters');
// Limiters will be applied explicitly to routes below

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
// Apply spam + general limiters to all API endpoints, but leave health check (/) unfiltered.
app.use('/auth', spamLimiter, generalLimiter, require('./routes/auth'));
app.use('/user', spamLimiter, generalLimiter, require('./routes/users'));
app.use('/ideas', spamLimiter, generalLimiter, require('./routes/ideas'));
app.use('/like', spamLimiter, generalLimiter, require('./routes/likes'));
app.use('/comment', spamLimiter, generalLimiter, require('./routes/comments'));
app.use('/follow', spamLimiter, generalLimiter, require('./routes/follows'));
app.use('/interest', spamLimiter, generalLimiter, require('./routes/interests'));
app.use('/chat', spamLimiter, generalLimiter, require('./routes/chats'));
app.use('/notifications', spamLimiter, generalLimiter, require('./routes/notifications'));
app.use('/admin', spamLimiter, generalLimiter, require('./routes/admin'));

// ── Health Check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Zerox API is running', uptime: Math.floor(process.uptime()) });
});

// ── Global Error Handler (must be last) ──
app.use(errorHandler);

// ════════════════════════════════════════════════════════════
// Socket.IO
// ════════════════════════════════════════════════════════════

const MAX_SOCKETS_PER_USER = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Track connections per user for limiting
const userSocketCount = new Map(); // userId → Set<socketId>

// Connection rate limiting per IP
const connectionAttempts = new Map(); // ip → { count, resetAt }

// ── Authentication Middleware ──
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    // Connection rate limiting: max 5 connections per minute per IP
    const ip = socket.handshake.address;
    const now = Date.now();
    const attempts = connectionAttempts.get(ip);
    if (attempts) {
      if (now < attempts.resetAt) {
        if (attempts.count >= 5) {
          return next(new Error('Too many connection attempts'));
        }
        attempts.count++;
      } else {
        connectionAttempts.set(ip, { count: 1, resetAt: now + 60000 });
      }
    } else {
      connectionAttempts.set(ip, { count: 1, resetAt: now + 60000 });
    }

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

    // Per-user connection limiting
    if (!userSocketCount.has(socket.userId)) {
      userSocketCount.set(socket.userId, new Set());
    }
    const userSockets = userSocketCount.get(socket.userId);
    userSockets.add(socket.id);

    // If over limit, disconnect oldest
    if (userSockets.size > MAX_SOCKETS_PER_USER) {
      const oldest = userSockets.values().next().value;
      const oldSocket = io.sockets.sockets.get(oldest);
      if (oldSocket && oldSocket.id !== socket.id) {
        oldSocket.emit('force_disconnect', { reason: 'Too many connections' });
        oldSocket.disconnect(true);
        logger.info(`[SocketLimit] Disconnected oldest socket ${oldest} for user ${socket.userId}`);
      }
    }
  }

  // Idle timeout tracking
  let lastActivity = Date.now();
  let idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      logger.info(`[IdleTimeout] Disconnecting idle socket ${socket.id} | user: ${socket.userId}`);
      socket.emit('idle_disconnect', { reason: 'Inactive for 5 minutes' });
      socket.disconnect(true);
    }
  }, 60000); // Check every minute
  idleTimer.unref && idleTimer.unref();

  function touchActivity() { lastActivity = Date.now(); }

  // Per-socket anti-spam timestamps
  let lastMessageTime = 0;

  socket.on('user_online', () => {
    touchActivity();
    if (socket.userId) onlineUsers.set(socket.userId, socket.id);
  });

  socket.on('join_chat', async ({ chatId }) => {
    touchActivity();
    try {
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
    } catch (err) {
      logger.error('join_chat error:', err.message);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });

  socket.on('send_message', async ({ chatId, message }) => {
    touchActivity();
    const senderId = socket.userId;
    try {
      const now = Date.now();
      if (now - lastMessageTime < 1000) {
        socket.emit('error', { message: 'Sending messages too fast. Please slow down.' });
        return;
      }
      lastMessageTime = now;

      if (!chatId || !message || typeof message !== 'string' || message.trim().length === 0) {
        socket.emit('error', { message: 'Invalid message' });
        return;
      }
      const sanitizedMessage = message.trim().substring(0, 2000);

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

      const { data, error } = await supabase
        .from('messages')
        .insert({ chat_id: chatId, sender_id: senderId, message: sanitizedMessage })
        .select('*, sender:users!messages_sender_id_fkey(id, name, profile_image)')
        .single();

      if (error) throw error;

      await supabase
        .from('chats')
        .update({ last_message: sanitizedMessage, last_message_at: new Date().toISOString() })
        .eq('id', chatId);

      io.to(`chat_${chatId}`).emit('receive_message', data);

      try {
        const senderName = data.sender?.name || 'Someone';
        await sendChatPushNotification(supabase, io, onlineUsers, {
          recipientId,
          senderName,
          messageText: sanitizedMessage.length > 100 ? sanitizedMessage.substring(0, 100) + '...' : sanitizedMessage,
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
    touchActivity();
    socket.to(`chat_${chatId}`).emit('user_typing', { userId });
  });

  socket.on('stop_typing', ({ chatId, userId }) => {
    socket.to(`chat_${chatId}`).emit('user_stop_typing', { userId });
  });

  socket.on('error', (err) => {
    logger.error(`Socket error for user ${socket.userId}:`, err.message);
  });

  socket.on('disconnect', async () => {
    clearInterval(idleTimer);

    // Cleanup user socket tracking
    if (socket.userId) {
      const userSockets = userSocketCount.get(socket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) userSocketCount.delete(socket.userId);
      }

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

    // Clean stale online users from previous crash/restart
    try {
      const redis = getRedis();
      await redis.del('zerox:online_users');
      logger.info('[Startup] Cleared stale online users');
    } catch (e) {
      logger.warn('[Startup] Could not clear stale users:', e.message);
    }

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
  // Record for admin panel
  const { recordError } = require('./middleware/loadShedding');
  recordError(`Unhandled Rejection: ${reason?.message || reason}`, { type: 'unhandled_rejection' });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
  const { recordError } = require('./middleware/loadShedding');
  recordError(`Uncaught Exception: ${err.message}`, { type: 'uncaught_exception' });
  // Give time for log flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

start();
