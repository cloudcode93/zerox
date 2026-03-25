'use strict';

const express = require('express');
const router = express.Router();
const os = require('os');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const logger = require('../config/logger');
const { getRedis } = require('../config/redis');
const cache = require('../lib/cache');
const { getNotificationQueue, getCleanupQueue } = require('../queues/queues');

// ── Default Settings ──
const DEFAULT_SETTINGS = {
  maintenance_mode: 'false',
  require_email_verification: 'false',
  allow_new_registrations: 'true',
  disable_chat: 'false',
  disable_posting: 'false',
  enable_beta: 'false',
};

const ALLOWED_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

// ── Seed Redis settings on first load ──
(async () => {
  try {
    const redis = getRedis();
    const existing = await redis.hgetall('zerox:settings');
    if (!existing || Object.keys(existing).length === 0) {
      await redis.hmset('zerox:settings', DEFAULT_SETTINGS);
      logger.info('[Admin] Default settings seeded to Redis');
    }
  } catch (e) {
    logger.warn('[Admin] Could not seed settings:', e.message);
  }
})();

// ════════════════════════════════════════════════════════════
// 1. DASHBOARD STATS (cached 60s)
// ════════════════════════════════════════════════════════════
router.get('/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Check cache first
    const cached = await cache.get('admin:stats');
    if (cached) return res.json(cached);

    const supabase = req.app.get('supabase');
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const oneDayAgo = new Date(now - 86400000).toISOString();
    const oneWeekAgo = new Date(now - 7 * 86400000).toISOString();
    const oneMonthAgo = new Date(now - 30 * 86400000).toISOString();

    const [
      { count: total_users },
      { count: total_ideas },
      { count: active_chats },
      { count: total_interests },
      { count: total_messages },
      { count: total_likes },
      { count: total_comments },
      { count: total_follows },
      { count: new_users_today },
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('ideas').select('*', { count: 'exact', head: true }).eq('is_deleted', false),
      supabase.from('chats').select('*', { count: 'exact', head: true }),
      supabase.from('interests').select('*', { count: 'exact', head: true }),
      supabase.from('messages').select('*', { count: 'exact', head: true }),
      supabase.from('likes').select('*', { count: 'exact', head: true }),
      supabase.from('comments').select('*', { count: 'exact', head: true }),
      supabase.from('follows').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', todayStr),
    ]);

    const { count: dau } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', oneDayAgo);
    const { count: wau } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', oneWeekAgo);
    const { count: mau } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', oneMonthAgo);

    const { count: founders_count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'founder');
    const { count: investors_count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'investor');

    // Pending reports from Supabase
    let pending_reports = 0;
    try {
      const { count } = await supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'pending');
      pending_reports = count || 0;
    } catch (_) {}

    const result = {
      stats: {
        total_users: total_users || 0,
        total_ideas: total_ideas || 0,
        active_chats: active_chats || 0,
        total_interests: total_interests || 0,
        total_messages: total_messages || 0,
        total_likes: total_likes || 0,
        total_comments: total_comments || 0,
        total_follows: total_follows || 0,
        new_users_today: new_users_today || 0,
        dau: dau || 0,
        wau: wau || 0,
        mau: mau || 0,
        total_engagement: (total_likes || 0) + (total_comments || 0) + (total_follows || 0),
        founders_count: founders_count || 0,
        investors_count: investors_count || 0,
        pending_reports,
      },
    };

    // Cache for 60 seconds
    await cache.set('admin:stats', result, 60);
    return res.json(result);
  } catch (err) {
    logger.error('Admin stats error:', err);
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ════════════════════════════════════════════════════════════
// 1b. LIVE USERS
// ════════════════════════════════════════════════════════════
router.get('/live-users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const onlineUsers = req.app.get('onlineUsers');
    const onlineUserIds = await onlineUsers.keys();

    if (onlineUserIds.length === 0) {
      return res.json({ users: [], count: 0 });
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, role, profile_image, created_at')
      .in('id', onlineUserIds);

    if (error) throw error;
    return res.json({ users: users || [], count: onlineUserIds.length });
  } catch (err) {
    logger.error('Live users error:', err);
    return res.status(500).json({ error: 'Failed to get live users' });
  }
});

// ════════════════════════════════════════════════════════════
// 1b2. ONLINE USER HISTORY
// ════════════════════════════════════════════════════════════
router.get('/online-history', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const hours = parseInt(req.query.hours) || 24;
    const since = new Date(Date.now() - hours * 3600000).toISOString();

    const { data, error } = await supabase
      .from('online_user_snapshots')
      .select('user_count, recorded_at')
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true });

    if (error) throw error;
    return res.json({ snapshots: data || [], hours });
  } catch (err) {
    if (err.code === '42P01') return res.json({ snapshots: [], hours: 24 });
    logger.error('Online history error:', err);
    return res.status(500).json({ error: 'Failed to get online history' });
  }
});

router.post('/record-snapshot', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const onlineUsers = req.app.get('onlineUsers');
    const count = await onlineUsers.size();

    const { error } = await supabase.from('online_user_snapshots').insert({ user_count: count });
    if (error) throw error;
    return res.json({ message: 'Snapshot recorded', count });
  } catch (err) {
    logger.error('Record snapshot error:', err);
    return res.status(500).json({ error: 'Failed to record snapshot' });
  }
});

// ════════════════════════════════════════════════════════════
// 1c. DATABASE STATS
// ════════════════════════════════════════════════════════════
router.get('/db-stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const tables = ['users', 'ideas', 'messages', 'chats', 'likes', 'comments', 'follows', 'interests', 'notifications'];
    const counts = {};

    await Promise.all(tables.map(async (table) => {
      try {
        const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
        counts[table] = count || 0;
      } catch (_) {
        counts[table] = 0;
      }
    }));

    let db_size = { used_bytes: 0, used_mb: 0, total_mb: 500 };
    try {
      const { data: sizeData } = await supabase.rpc('get_db_size');
      if (sizeData) {
        db_size.used_bytes = sizeData;
        db_size.used_mb = Math.round(sizeData / (1024 * 1024) * 100) / 100;
      }
    } catch (_) {
      const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
      db_size.used_mb = Math.round(totalRows * 0.002 * 100) / 100;
    }

    return res.json({ tables: counts, db_size });
  } catch (err) {
    logger.error('DB stats error:', err);
    return res.status(500).json({ error: 'Failed to get DB stats' });
  }
});

// ════════════════════════════════════════════════════════════
// 6. DASHBOARD ANALYTICS
// ════════════════════════════════════════════════════════════
router.get('/analytics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { getCache, setCache } = require('../utils/memoryCache');
    const cacheKey = req.originalUrl;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const supabase = req.app.get('supabase');
    const days = parseInt(req.query.days) || 30;
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - days);
    const startDate = pastDate.toISOString();

    const { data: users, error } = await supabase.from('users').select('created_at').gte('created_at', startDate);
    if (error) throw error;

    // Group users by day
    const userGrowth = [];
    if (users) {
      const counts = {};
      users.forEach(u => {
        const date = u.created_at.split('T')[0];
        counts[date] = (counts[date] || 0) + 1;
      });
      for (let i = 0; i < days; i++) {
        const d = new Date(pastDate);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        userGrowth.push({ date: dateStr, count: counts[dateStr] || 0 });
      }
    }

    // Fetch 24-hour server load from in-memory recorders
    const { getLongTermMetrics } = require('../middleware/loadShedding');
    const serverLoad24h = getLongTermMetrics().serverLoad24h || [];

    const result = {
      users: userGrowth,
      server_load_24h: serverLoad24h,
    };
    
    setCache(cacheKey, result, 10);
    return res.json(result);
  } catch (err) {
    logger.error('Admin analytics error:', err);
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

router.post('/optimize-db', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { data: deletedIdeas, error: ideaErr } = await supabase
      .from('ideas').delete().eq('is_deleted', true).select('id');
    if (ideaErr) throw ideaErr;

    return res.json({
      success: true,
      message: `Database optimization triggered. Cleaned ${(deletedIdeas || []).length} soft-deleted items.`,
    });
  } catch (err) {
    logger.error('Optimize DB error:', err);
    return res.status(500).json({ error: 'Failed to optimize database' });
  }
});

// ════════════════════════════════════════════════════════════
// 2. ANALYTICS (cached 300s)
// ════════════════════════════════════════════════════════════
router.get('/analytics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const cacheKey = `admin:analytics:${days}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const supabase = req.app.get('supabase');
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - days);
    const startIso = startDate.toISOString();

    const [
      { data: users },
      { data: ideas },
      { data: messages },
      { data: likes },
      { data: comments },
      { data: follows },
    ] = await Promise.all([
      supabase.from('users').select('created_at').gte('created_at', startIso),
      supabase.from('ideas').select('created_at').eq('is_deleted', false).gte('created_at', startIso),
      supabase.from('messages').select('created_at').gte('created_at', startIso),
      supabase.from('likes').select('created_at').gte('created_at', startIso),
      supabase.from('comments').select('created_at').gte('created_at', startIso),
      supabase.from('follows').select('created_at').gte('created_at', startIso),
    ]);

    const result = { users: [], ideas: [], messages: [], likes: [], comments: [], follows: [] };

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const countForDate = (arr) => (arr || []).filter(r => r.created_at && r.created_at.startsWith(dateStr)).length;

      result.users.push({ date: dateStr, count: countForDate(users) });
      result.ideas.push({ date: dateStr, count: countForDate(ideas) });
      result.messages.push({ date: dateStr, count: countForDate(messages) });
      result.likes.push({ date: dateStr, count: countForDate(likes) });
      result.comments.push({ date: dateStr, count: countForDate(comments) });
      result.follows.push({ date: dateStr, count: countForDate(follows) });
    }

    await cache.set(cacheKey, result, 300);
    return res.json(result);
  } catch (err) {
    logger.error('Admin analytics error:', err);
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ════════════════════════════════════════════════════════════
// 3. TOP USERS & TOP IDEAS
// ════════════════════════════════════════════════════════════
router.get('/analytics/top-users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, profile_image, role, followers_count, ideas_count')
      .order('followers_count', { ascending: false })
      .limit(10);

    if (error) throw error;
    return res.json({ users: users || [] });
  } catch (err) {
    logger.error('Top users error:', err);
    return res.status(500).json({ error: 'Failed' });
  }
});

router.get('/analytics/top-ideas', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { data: ideas, error } = await supabase
      .from('ideas')
      .select('id, problem, likes_count, comments_count, category, user:users!ideas_user_id_fkey(name)')
      .eq('is_deleted', false)
      .order('likes_count', { ascending: false })
      .limit(10);

    if (error) throw error;
    return res.json({ ideas: ideas || [] });
  } catch (err) {
    logger.error('Top ideas error:', err);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ════════════════════════════════════════════════════════════
// 4. USER MANAGEMENT
// ════════════════════════════════════════════════════════════
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const role = req.query.role || '';

    let query = supabase.from('users').select('*', { count: 'exact' });
    if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    if (role) query = query.eq('role', role);

    const { data: users, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return res.json({ users: users || [], total: count });
  } catch (err) {
    logger.error('Admin users error:', err);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.put('/users/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const userId = req.params.id;

    const { data: currentAdmin } = await supabase.from('users').select('id').eq('supabase_uid', req.supabaseUser.id).single();
    if (currentAdmin && currentAdmin.id === userId) {
      return res.status(400).json({ error: 'You cannot ban yourself' });
    }

    const { data: user, error: fetchErr } = await supabase
      .from('users').select('is_banned, is_admin').eq('id', userId).single();
    if (fetchErr || !user) return res.status(404).json({ error: 'User not found' });
    if (user.is_admin) return res.status(400).json({ error: 'Cannot ban another admin' });

    const newStatus = !user.is_banned;
    const { data: updatedUser, error: updateErr } = await supabase
      .from('users').update({ is_banned: newStatus }).eq('id', userId).select().single();
    if (updateErr) throw updateErr;

    return res.json({ message: newStatus ? 'User banned' : 'User unbanned', user: updatedUser });
  } catch (err) {
    logger.error('Admin ban error:', err);
    return res.status(500).json({ error: 'Failed to modify ban status' });
  }
});

router.delete('/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const userId = req.params.id;

    const { data: currentAdmin } = await supabase.from('users').select('id').eq('supabase_uid', req.supabaseUser.id).single();
    if (currentAdmin && currentAdmin.id === userId) return res.status(400).json({ error: 'You cannot delete yourself' });

    const { data: targetUser } = await supabase.from('users').select('is_admin').eq('id', userId).single();
    if (targetUser && targetUser.is_admin) return res.status(400).json({ error: 'Cannot delete another admin' });

    const { error } = await supabase.from('users').delete().eq('id', userId);
    if (error) throw error;
    return res.json({ message: 'User deleted' });
  } catch (err) {
    logger.error('Delete user error:', err);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.put('/users/:id/role', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { role } = req.body;
    const { data, error } = await supabase
      .from('users').update({ role }).eq('id', req.params.id).select().single();
    if (error) throw error;
    return res.json({ user: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to change role' });
  }
});

// ════════════════════════════════════════════════════════════
// 5. IDEA / POST MANAGEMENT
// ════════════════════════════════════════════════════════════
router.get('/ideas', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const search = req.query.search || '';
    const category = req.query.category || '';

    let query = supabase
      .from('ideas')
      .select('*, user:users!ideas_user_id_fkey(id, name, profile_image)')
      .eq('is_deleted', false);

    if (category) query = query.eq('category', category);
    if (search) query = query.or(`problem.ilike.%${search}%,solution.ilike.%${search}%`);

    const { data: ideas, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ ideas: ideas || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch ideas' });
  }
});

router.delete('/ideas/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { error } = await supabase.from('ideas').update({ is_deleted: true }).eq('id', req.params.id);
    if (error) throw error;
    return res.json({ message: 'Idea deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete' });
  }
});

// ════════════════════════════════════════════════════════════
// 6. REPORTS (now using Supabase — not ephemeral filesystem)
// ════════════════════════════════════════════════════════════
router.get('/reports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const status = req.query.status;

    let query = supabase.from('reports').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);

    const { data: reports, error } = await query;
    if (error) throw error;

    // Enrich with user profiles
    const enriched = await Promise.all((reports || []).map(async (report) => {
      let reporterInfo = null;
      if (report.reporter_uid) {
        const { data } = await supabase.from('users').select('id, name, profile_image').eq('supabase_uid', report.reporter_uid).single();
        if (data) reporterInfo = data;
      }
      let targetInfo = null;
      if (report.target_type === 'user' && report.target_id) {
        const { data } = await supabase.from('users').select('id, name, profile_image').eq('id', report.target_id).single();
        if (data) targetInfo = data;
      }
      return { ...report, reporter: reporterInfo, target_user: targetInfo };
    }));

    return res.json({ reports: enriched });
  } catch (err) {
    logger.error('Get reports error:', err);
    return res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

router.delete('/reports/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { error } = await supabase.from('reports').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ message: 'Report deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete report' });
  }
});

router.post('/reports', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { target_id, target_type, reason } = req.body;

    const { data: report, error } = await supabase.from('reports').insert({
      target_id,
      target_type,
      reason,
      reporter_uid: req.supabaseUser.id,
      status: 'pending',
    }).select().single();

    if (error) throw error;
    return res.json({ report });
  } catch (err) {
    logger.error('Submit report error:', err);
    return res.status(500).json({ error: 'Failed to submit report' });
  }
});

router.put('/reports/:id/resolve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    await supabase.from('reports').update({ status: 'resolved' }).eq('id', req.params.id);
    return res.json({ message: 'Resolved' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

router.put('/reports/:id/ignore', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    await supabase.from('reports').update({ status: 'ignored' }).eq('id', req.params.id);
    return res.json({ message: 'Ignored' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

// ════════════════════════════════════════════════════════════
// 7. CHAT MONITORING
// ════════════════════════════════════════════════════════════
router.get('/chats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const search = req.query.search || '';

    const { data: chats, error } = await supabase
      .from('chats')
      .select('*, user1:users!chats_user1_id_fkey(id,name,profile_image), user2:users!chats_user2_id_fkey(id,name,profile_image)')
      .order('last_message_at', { ascending: false });
    if (error) throw error;

    let filtered = chats || [];
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(c =>
        (c.user1?.name || '').toLowerCase().includes(s) ||
        (c.user2?.name || '').toLowerCase().includes(s)
      );
    }
    return res.json({ chats: filtered });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

router.get('/chats/:chatId/messages', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*, sender:users!messages_sender_id_fkey(id, name)')
      .eq('chat_id', req.params.chatId)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) throw error;
    return res.json({ messages: messages || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ════════════════════════════════════════════════════════════
// 8. SYSTEM HEALTH & MONITORING
// ════════════════════════════════════════════════════════════
const { getMetrics, getRecentErrors, getAlerts, getHistory } = require('../middleware/loadShedding');

router.get('/system/health', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { getCache, setCache } = require('../utils/memoryCache');
    const cacheKey = req.originalUrl;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    // Get centralized metrics from loadShedding module
    const systemMetrics = getMetrics();
    const alerts = getAlerts();

    // Redis info
    let redisInfo = null;
    try {
      const redis = getRedis();
      const info = await redis.info('memory');
      const memMatch = info.match(/used_memory_human:(.+)/);
      const peakMatch = info.match(/used_memory_peak_human:(.+)/);
      const connectedMatch = await redis.info('clients');
      const clientMatch = connectedMatch.match(/connected_clients:(\d+)/);

      redisInfo = {
        used_memory: memMatch ? memMatch[1].trim() : 'N/A',
        peak_memory: peakMatch ? peakMatch[1].trim() : 'N/A',
        connected_clients: clientMatch ? parseInt(clientMatch[1]) : 0,
      };
    } catch (e) {
      redisInfo = { error: 'Redis unavailable' };
    }

    // Queue metrics
    let queueMetrics = {};
    try {
      const notifQ = getNotificationQueue();
      const cleanupQ = getCleanupQueue();

      const [nWaiting, nActive, nFailed, nDelayed, cWaiting, cActive, cFailed, cDelayed] = await Promise.all([
        notifQ.getWaitingCount(),
        notifQ.getActiveCount(),
        notifQ.getFailedCount(),
        notifQ.getDelayedCount(),
        cleanupQ.getWaitingCount(),
        cleanupQ.getActiveCount(),
        cleanupQ.getFailedCount(),
        cleanupQ.getDelayedCount(),
      ]);

      queueMetrics = {
        notifications: { waiting: nWaiting, active: nActive, failed: nFailed, delayed: nDelayed },
        cleanup: { waiting: cWaiting, active: cActive, failed: cFailed, delayed: cDelayed },
      };
    } catch (e) {
      queueMetrics = { error: 'Queues unavailable' };
    }

    // Online users count
    const onlineUsers = req.app.get('onlineUsers');
    const onlineCount = await onlineUsers.size();

    // Socket.IO connections
    const io = req.app.get('io');
    const socketCount = io ? io.engine?.clientsCount || 0 : 0;

    const result = {
      health: {
        server_status: 'Online',
        ...systemMetrics,
        online_users: onlineCount,
        socket_connections: socketCount,
      },
      redis: redisInfo,
      queues: queueMetrics,
      alerts,
    };
    
    setCache(cacheKey, result, 10);
    return res.json(result);
  } catch (err) {
    logger.error('System health error:', err);
    return res.status(500).json({ error: 'Failed to get health' });
  }
});

// ════════════════════════════════════════════════════════════
// 8d. SYSTEM LOGS, ALERTS & HISTORY (for admin panel)
// ════════════════════════════════════════════════════════════
router.get('/system/logs', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { getCache, setCache } = require('../utils/memoryCache');
    const cacheKey = req.originalUrl;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const errors = getRecentErrors();
    const alerts = getAlerts();
    const systemMetrics = getMetrics();
    const historyData = getHistory();

    // Fetch 1-hour traffic from in-memory recorders
    const { getLongTermMetrics } = require('../middleware/loadShedding');
    const traffic1h = getLongTermMetrics().traffic1h || [];

    const result = {
      errors,
      alerts,
      metrics: {
        event_loop_lag_ms: systemMetrics.event_loop_lag_ms,
        active_requests: systemMetrics.active_requests,
        requests_per_second: systemMetrics.requests_per_second,
        total_requests: systemMetrics.total_requests,
        rejected_requests: systemMetrics.rejected_requests,
        timed_out_requests: systemMetrics.timed_out_requests,
        dynamic_max_requests: systemMetrics.dynamic_max_requests,
      },
      history: historyData,
      traffic_1h: traffic1h,
    };
    
    setCache(cacheKey, result, 10);
    return res.json(result);
  } catch (err) {
    logger.error('System logs error:', err);
    return res.status(500).json({ error: 'Failed to get logs' });
  }
});

// ════════════════════════════════════════════════════════════
// 8b. QUEUE CONTROLS
// ════════════════════════════════════════════════════════════
function _getQueueByName(name) {
  if (name === 'notifications') return getNotificationQueue();
  if (name === 'cleanup') return getCleanupQueue();
  return null;
}

router.post('/system/queue/:name/pause', authMiddleware, adminMiddleware, async (req, res) => {
  const queue = _getQueueByName(req.params.name);
  if (!queue) return res.status(404).json({ error: 'Queue not found' });
  await queue.pause();
  logger.info(`[Admin] Queue "${req.params.name}" paused`);
  return res.json({ message: `Queue "${req.params.name}" paused` });
});

router.post('/system/queue/:name/resume', authMiddleware, adminMiddleware, async (req, res) => {
  const queue = _getQueueByName(req.params.name);
  if (!queue) return res.status(404).json({ error: 'Queue not found' });
  await queue.resume();
  logger.info(`[Admin] Queue "${req.params.name}" resumed`);
  return res.json({ message: `Queue "${req.params.name}" resumed` });
});

router.post('/system/queue/:name/retry-failed', authMiddleware, adminMiddleware, async (req, res) => {
  const queue = _getQueueByName(req.params.name);
  if (!queue) return res.status(404).json({ error: 'Queue not found' });
  const failed = await queue.getFailed(0, 100);
  let retried = 0;
  for (const job of failed) {
    await job.retry();
    retried++;
  }
  logger.info(`[Admin] Retried ${retried} failed jobs in "${req.params.name}"`);
  return res.json({ message: `Retried ${retried} failed jobs` });
});

router.post('/system/queue/:name/clear', authMiddleware, adminMiddleware, async (req, res) => {
  const queue = _getQueueByName(req.params.name);
  if (!queue) return res.status(404).json({ error: 'Queue not found' });
  await queue.drain();
  logger.info(`[Admin] Queue "${req.params.name}" cleared`);
  return res.json({ message: `Queue "${req.params.name}" cleared` });
});

// ════════════════════════════════════════════════════════════
// 8c. SOCKET.IO BROADCAST
// ════════════════════════════════════════════════════════════
router.post('/system/broadcast', authMiddleware, adminMiddleware, (req, res) => {
  const { event, data } = req.body;
  if (!event || !data) return res.status(400).json({ error: 'event and data required' });

  const io = req.app.get('io');
  io.emit(event, data);
  logger.info(`[Admin] Broadcast: ${event}`, data);
  return res.json({ success: true, event });
});

// ════════════════════════════════════════════════════════════
// 9. DATA CLEANUP
// ════════════════════════════════════════════════════════════
router.post('/cleanup', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const { count: deletedMessages } = await supabase
      .from('messages').delete().lt('created_at', sevenDaysAgo)
      .select('*', { count: 'exact', head: true });

    const { count: deletedNotifications } = await supabase
      .from('notifications').delete().lt('created_at', sevenDaysAgo)
      .select('*', { count: 'exact', head: true });

    return res.json({
      message: 'Cleanup completed',
      deleted_messages: deletedMessages || 0,
      deleted_notifications: deletedNotifications || 0,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Cleanup failed' });
  }
});

// ════════════════════════════════════════════════════════════
// 10. SETTINGS (Redis-backed — survives Render redeploys)
// ════════════════════════════════════════════════════════════
router.get('/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const redis = getRedis();
    const settings = await redis.hgetall('zerox:settings');

    // Convert string values to booleans for consistent API
    const parsed = {};
    for (const [key, val] of Object.entries(settings || {})) {
      parsed[key] = val === 'true';
    }

    return res.json({ settings: parsed });
  } catch (err) {
    logger.error('Get settings error:', err);
    return res.status(500).json({ error: 'Failed to get settings' });
  }
});

router.put('/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || !ALLOWED_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ error: `Invalid setting key. Allowed: ${ALLOWED_SETTING_KEYS.join(', ')}` });
    }

    const redis = getRedis();
    await redis.hset('zerox:settings', key, String(value));

    const settings = await redis.hgetall('zerox:settings');
    const parsed = {};
    for (const [k, v] of Object.entries(settings || {})) {
      parsed[k] = v === 'true';
    }

    logger.info(`[Admin] Setting updated: ${key} = ${value}`);
    return res.json({ settings: parsed });
  } catch (err) {
    logger.error('Update settings error:', err);
    return res.status(500).json({ error: 'Failed to update setting' });
  }
});

// ════════════════════════════════════════════════════════════
// 11. NOTIFICATIONS CONTROL
// ════════════════════════════════════════════════════════════
router.post('/notifications/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });

    const { data: tokens } = await supabase.from('device_tokens').select('fcm_token');

    if (tokens && tokens.length > 0) {
      const admin = require('firebase-admin');
      if (admin.apps.length === 0) return res.json({ success: true, sent: 0, total: tokens.length, reason: 'firebase_not_initialized' });

      let sent = 0;
      for (const t of tokens) {
        try {
          await admin.messaging().send({
            token: t.fcm_token,
            notification: { title, body },
            data: { type: 'system', title, body },
          });
          sent++;
        } catch (e) { /* skip invalid tokens */ }
      }
      return res.json({ success: true, sent, total: tokens.length });
    }
    return res.json({ success: true, sent: 0, total: 0 });
  } catch (err) {
    logger.error('Broadcast error:', err);
    return res.status(500).json({ error: 'Broadcast failed' });
  }
});

router.post('/notifications/send', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { user_id, title, body } = req.body;
    if (!user_id || !title || !body) return res.status(400).json({ error: 'user_id, title, body required' });

    const { data: tokens } = await supabase.from('device_tokens').select('fcm_token').eq('user_id', user_id);
    if (tokens && tokens.length > 0) {
      const admin = require('firebase-admin');
      if (admin.apps.length > 0) {
        for (const t of tokens) {
          try {
            await admin.messaging().send({
              token: t.fcm_token,
              notification: { title, body },
              data: { type: 'system', title, body },
            });
          } catch (e) {}
        }
      }
    }

    await supabase.from('notifications').insert({
      user_id,
      type: 'system',
      message: `${title}: ${body}`,
    });

    return res.json({ success: true });
  } catch (err) {
    logger.error('Send notification error:', err);
    return res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ════════════════════════════════════════════════════════════
// 12. SECURITY OVERVIEW
// ════════════════════════════════════════════════════════════
router.get('/security', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const onlineUsers = req.app.get('onlineUsers');

    const { count: bannedUsers } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_banned', true);

    let pendingReports = 0;
    try {
      const { count } = await supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'pending');
      pendingReports = count || 0;
    } catch (_) {}

    return res.json({
      failed_logins_24h: 0,
      active_sessions: await onlineUsers.size(),
      banned_users: bannedUsers || 0,
      pending_reports: pendingReports,
      alerts: [],
    });
  } catch (err) {
    logger.error('Security error:', err);
    return res.status(500).json({ error: 'Failed to load security data' });
  }
});

// ════════════════════════════════════════════════════════════
// 13. EXPORT DATA
// ════════════════════════════════════════════════════════════
router.get('/export/:type', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { type } = req.params;
    let data, count;

    switch (type) {
      case 'user':
        ({ data } = await supabase.from('users').select('id, name, email, role, created_at, followers_count, following_count, ideas_count'));
        count = data?.length ?? 0;
        break;
      case 'idea':
        ({ data } = await supabase.from('ideas').select('id, problem, solution, category, created_at, likes_count, comments_count'));
        count = data?.length ?? 0;
        break;
      case 'message':
        ({ data } = await supabase.from('messages').select('id, sender_id, message, created_at').limit(1000));
        count = data?.length ?? 0;
        break;
      default:
        return res.status(400).json({ error: 'Invalid export type' });
    }

    return res.json({ data: data || [], count, type });
  } catch (err) {
    logger.error('Export error:', err);
    return res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
