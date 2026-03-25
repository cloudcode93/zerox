const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ── Admin Middleware ──
const adminMiddleware = async (req, res, next) => {
  try {
    const supabase = req.app.get('supabase');
    const { data: user, error } = await supabase
      .from('users')
      .select('is_admin')
      .eq('supabase_uid', req.supabaseUser.id)
      .single();

    if (error || !user || !user.is_admin) {
      return res.status(403).json({ error: 'Forbidden: Admin access only' });
    }
    next();
  } catch (err) {
    console.error('Admin middleware error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ── Settings & Reports file paths ──
const settingsPath = path.join(__dirname, '../settings.json');
const reportsPath = path.join(__dirname, '../reports.json');

const defaultSettings = {
  maintenance_mode: false,
  require_email_verification: false,
  allow_new_registrations: true,
  disable_chat: false,
  disable_posting: false,
  enable_beta: false
};

if (!fs.existsSync(settingsPath)) {
  fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings));
}
if (!fs.existsSync(reportsPath)) {
  fs.writeFileSync(reportsPath, JSON.stringify([]));
}

// ════════════════════════════════════════════════════════════
// 1. DASHBOARD STATS
// ════════════════════════════════════════════════════════════
router.get('/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Core counts
    const [
      { count: total_users },
      { count: total_ideas },
      { count: active_chats },
      { count: total_interests },
      { count: total_messages },
      { count: total_likes },
      { count: total_comments },
      { count: total_follows },
      { count: new_users_today }
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('ideas').select('*', { count: 'exact', head: true }).eq('is_deleted', false),
      supabase.from('chats').select('*', { count: 'exact', head: true }),
      supabase.from('interests').select('*', { count: 'exact', head: true }),
      supabase.from('messages').select('*', { count: 'exact', head: true }),
      supabase.from('likes').select('*', { count: 'exact', head: true }),
      supabase.from('comments').select('*', { count: 'exact', head: true }),
      supabase.from('follows').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', todayStr)
    ]);

    // DAU / WAU / MAU
    const { count: dau } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', oneDayAgo);
    const { count: wau } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', oneWeekAgo);
    const { count: mau } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', oneMonthAgo);

    // Role distribution for pie chart
    const { count: founders_count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'founder');
    const { count: investors_count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'investor');

    // Pending reports count
    let pending_reports = 0;
    try {
      const reports = JSON.parse(fs.readFileSync(reportsPath));
      pending_reports = reports.filter(r => r.status === 'pending').length;
    } catch (_) {}

    return res.json({
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
        pending_reports: pending_reports
      }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
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
    const onlineUserIds = onlineUsers ? Array.from(onlineUsers.keys()) : [];

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
    console.error('Live users error:', err);
    return res.status(500).json({ error: 'Failed to get live users' });
  }
});

// ════════════════════════════════════════════════════════════
// 1b2. ONLINE USER HISTORY (last 24h for chart)
// ════════════════════════════════════════════════════════════
router.get('/online-history', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const hours = parseInt(req.query.hours) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('online_user_snapshots')
      .select('user_count, recorded_at')
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true });

    if (error) throw error;
    return res.json({ snapshots: data || [], hours });
  } catch (err) {
    // If table doesn't exist return empty
    if (err.code === '42P01') {
      return res.json({ snapshots: [], hours: 24 });
    }
    console.error('Online history error:', err);
    return res.status(500).json({ error: 'Failed to get online history' });
  }
});

// Manually record a snapshot (for seeding initial data)
router.post('/record-snapshot', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const onlineUsers = req.app.get('onlineUsers');
    const count = onlineUsers ? onlineUsers.size : 0;

    const { error } = await supabase
      .from('online_user_snapshots')
      .insert({ user_count: count });

    if (error) throw error;
    return res.json({ message: 'Snapshot recorded', count });
  } catch (err) {
    console.error('Record snapshot error:', err);
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

    // Get database size info
    let db_size = { used_bytes: 0, used_mb: 0, total_mb: 500 };
    try {
      const { data: sizeData } = await supabase.rpc('get_db_size');
      if (sizeData) {
        db_size.used_bytes = sizeData;
        db_size.used_mb = Math.round(sizeData / (1024 * 1024) * 100) / 100;
      }
    } catch (sizeErr) {
      // Fallback: estimate from row counts
      const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
      db_size.used_mb = Math.round(totalRows * 0.002 * 100) / 100; // rough estimate ~2KB per row
    }

    return res.json({ tables: counts, db_size });
  } catch (err) {
    console.error('DB stats error:', err);
    return res.status(500).json({ error: 'Failed to get DB stats' });
  }
});

// POST /admin/optimize-db
router.post('/optimize-db', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    
    // Force delete all soft-deleted ideas immediately to clear space
    const { data: deletedIdeas, error: ideaErr } = await supabase
      .from('ideas')
      .delete()
      .eq('is_deleted', true)
      .select('id');

    if (ideaErr) throw ideaErr;

    // We can't run a literal VACUUM SQL command over the REST API due to Postgres limitations,
    // but the backend's autovacuum daemon will reclaim the space based on these hardware deletes.
    return res.json({ 
      success: true, 
      message: `Database optimization triggered. Cleaned ${(deletedIdeas || []).length} soft-deleted items.`
    });
  } catch (err) {
    console.error('Optimize DB error:', err);
    return res.status(500).json({ error: 'Failed to optimize database' });
  }
});

// ════════════════════════════════════════════════════════════
// 2. ANALYTICS – 30-day time series
// ════════════════════════════════════════════════════════════
router.get('/analytics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const days = parseInt(req.query.days) || 30;
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
      { data: follows }
    ] = await Promise.all([
      supabase.from('users').select('created_at').gte('created_at', startIso),
      supabase.from('ideas').select('created_at').eq('is_deleted', false).gte('created_at', startIso),
      supabase.from('messages').select('created_at').gte('created_at', startIso),
      supabase.from('likes').select('created_at').gte('created_at', startIso),
      supabase.from('comments').select('created_at').gte('created_at', startIso),
      supabase.from('follows').select('created_at').gte('created_at', startIso)
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

    return res.json(result);
  } catch (err) {
    console.error('Admin analytics error:', err);
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
    console.error('Top users error:', err);
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
    console.error('Top ideas error:', err);
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

    let query = supabase
      .from('users')
      .select('*', { count: 'exact' });

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }
    if (role) {
      query = query.eq('role', role);
    }

    const { data: users, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return res.json({ users: users || [], total: count });
  } catch (err) {
    console.error('Admin users error:', err);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.put('/users/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const userId = req.params.id;

    // Prevent admin from banning themselves
    const { data: currentAdmin } = await supabase.from('users').select('id').eq('supabase_uid', req.supabaseUser.id).single();
    if (currentAdmin && currentAdmin.id === userId) {
      return res.status(400).json({ error: 'You cannot ban yourself' });
    }

    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('is_banned, is_admin')
      .eq('id', userId)
      .single();

    if (fetchErr || !user) return res.status(404).json({ error: 'User not found' });
    if (user.is_admin) return res.status(400).json({ error: 'Cannot ban another admin' });

    const newStatus = !user.is_banned;
    const { data: updatedUser, error: updateErr } = await supabase
      .from('users')
      .update({ is_banned: newStatus })
      .eq('id', userId)
      .select()
      .single();

    if (updateErr) throw updateErr;
    return res.json({ message: newStatus ? 'User banned' : 'User unbanned', user: updatedUser });
  } catch (err) {
    console.error('Admin ban error:', err);
    return res.status(500).json({ error: 'Failed to modify ban status' });
  }
});

router.delete('/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const userId = req.params.id;

    // Prevent admin from deleting themselves
    const { data: currentAdmin } = await supabase.from('users').select('id').eq('supabase_uid', req.supabaseUser.id).single();
    if (currentAdmin && currentAdmin.id === userId) {
      return res.status(400).json({ error: 'You cannot delete yourself' });
    }

    // Prevent deleting other admins
    const { data: targetUser } = await supabase.from('users').select('is_admin').eq('id', userId).single();
    if (targetUser && targetUser.is_admin) {
      return res.status(400).json({ error: 'Cannot delete another admin' });
    }

    const { error } = await supabase.from('users').delete().eq('id', userId);
    if (error) throw error;
    return res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.put('/users/:id/role', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { role } = req.body;
    const { data, error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', req.params.id)
      .select()
      .single();

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

    if (category) {
      query = query.eq('category', category);
    }
    if (search) {
      query = query.or(`problem.ilike.%${search}%,solution.ilike.%${search}%`);
    }

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
    const { error } = await supabase
      .from('ideas')
      .update({ is_deleted: true })
      .eq('id', req.params.id);

    if (error) throw error;
    return res.json({ message: 'Idea deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete' });
  }
});

// ════════════════════════════════════════════════════════════
// 6. REPORTS & MODERATION
// ════════════════════════════════════════════════════════════
router.get('/reports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const rawData = fs.readFileSync(reportsPath);
    const reports = JSON.parse(rawData);
    const status = req.query.status;
    let filtered = status ? reports.filter(r => r.status === status) : reports;

    // Attach user profile information
    const supabase = req.app.get('supabase');
    const enrichedReports = await Promise.all(filtered.map(async (report) => {
      // Fetch reporter info
      let reporterInfo = null;
      if (report.reporter_uid) {
        const { data } = await supabase.from('users').select('id, name, profile_image').eq('supabase_uid', report.reporter_uid).single();
        if (data) reporterInfo = data;
      }

      // Fetch target info if it's a user
      let targetInfo = null;
      if (report.target_type === 'user' && report.target_id) {
        const { data } = await supabase.from('users').select('id, name, profile_image').eq('id', report.target_id).single();
        if (data) targetInfo = data;
      }

      return {
        ...report,
        reporter: reporterInfo,
        target_user: targetInfo
      };
    }));

    return res.json({ reports: enrichedReports });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

router.delete('/reports/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let reports = JSON.parse(fs.readFileSync(reportsPath));
    const initialLength = reports.length;
    reports = reports.filter(r => r.id !== req.params.id);
    if (reports.length < initialLength) {
      fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));
      return res.json({ message: 'Report deleted' });
    }
    return res.status(404).json({ error: 'Report not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete report' });
  }
});

router.post('/reports', authMiddleware, async (req, res) => {
  try {
    const { target_id, target_type, reason } = req.body;
    const reports = JSON.parse(fs.readFileSync(reportsPath));
    const newReport = {
      id: Date.now().toString(),
      target_id,
      target_type,
      reason,
      reporter_uid: req.supabaseUser.id,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    reports.push(newReport);
    fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));
    return res.json({ report: newReport });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to submit report' });
  }
});

router.put('/reports/:id/resolve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const reports = JSON.parse(fs.readFileSync(reportsPath));
    const index = reports.findIndex(r => r.id === req.params.id);
    if (index > -1) {
      reports[index].status = 'resolved';
      fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));
    }
    return res.json({ message: 'Resolved' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

router.put('/reports/:id/ignore', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const reports = JSON.parse(fs.readFileSync(reportsPath));
    const index = reports.findIndex(r => r.id === req.params.id);
    if (index > -1) {
      reports[index].status = 'ignored';
      fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));
    }
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

    let query = supabase
      .from('chats')
      .select('*, user1:users!chats_user1_id_fkey(id,name,profile_image), user2:users!chats_user2_id_fkey(id,name,profile_image)')
      .order('last_message_at', { ascending: false });

    const { data: chats, error } = await query;
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
// 8. SYSTEM HEALTH
// ════════════════════════════════════════════════════════════
router.get('/system/health', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { getRedis, getIsConnected } = require('../services/redis');
    const redis = getRedis();

    // Fetch DB stats via RPC
    const { data: dbStats, error } = await supabase.rpc('get_database_stats');
    if (error) console.error('Error fetching DB stats:', error);

    // Multi-server metrics via Redis
    if (redis && getIsConnected()) {
      const serverHealthHash = await redis.hgetall('server_health');
      const instances = Object.keys(serverHealthHash || {});
      
      const healthArray = [];
      const historyMap = {};

      for (const id of instances) {
        healthArray.push({
          instance_id: id,
          ...JSON.parse(serverHealthHash[id])
        });

        const historyRaw = await redis.lrange(`metrics:${id}`, 0, 59);
        historyMap[id] = historyRaw.map(str => JSON.parse(str)).reverse(); // Reverse so oldest is first
      }

      return res.json({
        multi_server: true,
        health: healthArray,
        history: historyMap,
        db_stats: dbStats || null
      });
    }

    // Single-server fallback (Local Memory)
    const uptimeSeconds = process.uptime();
    const uptimeHours = (uptimeSeconds / 3600).toFixed(1);
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return res.json({
      multi_server: false,
      health: [{
        instance_id: process.env.RENDER_SERVICE_ID || 'local-dev',
        server_status: 'Online',
        uptime_hours: parseFloat(uptimeHours),
        memory_used_mb: Math.round(memUsage.rss / 1024 / 1024),
        heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
        system_memory_total_mb: Math.round(totalMem / 1024 / 1024),
        system_memory_free_mb: Math.round(freeMem / 1024 / 1024),
        node_version: process.version,
        platform: process.platform,
      }],
      history: {},
      db_stats: dbStats || null
    });
  } catch (err) {
    console.error('System health error:', err);
    return res.status(500).json({ error: 'Failed to get health' });
  }
});

// ════════════════════════════════════════════════════════════
// 9. DATA CLEANUP (Manual Trigger)
// ════════════════════════════════════════════════════════════
router.post('/cleanup', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: deletedMessages } = await supabase
      .from('messages')
      .delete()
      .lt('created_at', sevenDaysAgo)
      .select('*', { count: 'exact', head: true });

    const { count: deletedNotifications } = await supabase
      .from('notifications')
      .delete()
      .lt('created_at', sevenDaysAgo)
      .select('*', { count: 'exact', head: true });

    return res.json({
      message: 'Cleanup completed',
      deleted_messages: deletedMessages || 0,
      deleted_notifications: deletedNotifications || 0
    });
  } catch (err) {
    return res.status(500).json({ error: 'Cleanup failed' });
  }
});

// ════════════════════════════════════════════════════════════
// 10. SETTINGS & FEATURE FLAGS
// ════════════════════════════════════════════════════════════
router.get('/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const rawData = fs.readFileSync(settingsPath);
    return res.json({ settings: JSON.parse(rawData) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

const ALLOWED_SETTING_KEYS = ['maintenance_mode', 'require_email_verification', 'allow_new_registrations', 'disable_chat', 'disable_posting', 'enable_beta'];

router.put('/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key || !ALLOWED_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ error: `Invalid setting key. Allowed: ${ALLOWED_SETTING_KEYS.join(', ')}` });
    }

    const settings = JSON.parse(fs.readFileSync(settingsPath));
    settings[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return res.json({ settings });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

// ════════════════════════════════════════════════════════════
// NOTIFICATION CONTROL
// ════════════════════════════════════════════════════════════

// POST /admin/notifications/broadcast
router.post('/notifications/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });

    // Get all device tokens
    const { data: tokens } = await supabase.from('device_tokens').select('fcm_token');
    
    if (tokens && tokens.length > 0) {
      const admin = require('firebase-admin');
      let sent = 0;
      for (const t of tokens) {
        try {
          await admin.messaging().send({
            token: t.fcm_token,
            notification: { title, body },
            data: { type: 'system', title, body },
          });
          sent++;
        } catch (e) {
          // Skip invalid tokens
        }
      }
      return res.json({ success: true, sent, total: tokens.length });
    }
    return res.json({ success: true, sent: 0, total: 0 });
  } catch (err) {
    console.error('Broadcast error:', err);
    return res.status(500).json({ error: 'Broadcast failed' });
  }
});

// POST /admin/notifications/send (targeted)
router.post('/notifications/send', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const { user_id, title, body } = req.body;
    if (!user_id || !title || !body) return res.status(400).json({ error: 'user_id, title, body required' });

    // Get user tokens
    const { data: tokens } = await supabase.from('device_tokens').select('fcm_token').eq('user_id', user_id);
    
    if (tokens && tokens.length > 0) {
      const admin = require('firebase-admin');
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

    // Also insert as notification in DB
    await supabase.from('notifications').insert({
      user_id,
      type: 'system',
      message: `${title}: ${body}`,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Send notification error:', err);
    return res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════════════

const auditPath = path.join(__dirname, '../audit_log.json');
if (!fs.existsSync(auditPath)) {
  fs.writeFileSync(auditPath, JSON.stringify([]));
}

// GET /admin/audit-log
router.get('/audit-log', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const logs = JSON.parse(fs.readFileSync(auditPath));
    return res.json({ logs: logs.slice(-100).reverse() });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// ════════════════════════════════════════════════════════════
// EXPORT DATA
// ════════════════════════════════════════════════════════════

// GET /admin/export/:type
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
        ({ data } = await supabase.from('messages').select('id, sender_id, receiver_id, message, created_at').limit(1000));
        count = data?.length ?? 0;
        break;
      default:
        return res.status(400).json({ error: 'Invalid export type' });
    }

    return res.json({ data: data || [], count, type });
  } catch (err) {
    console.error('Export error:', err);
    return res.status(500).json({ error: 'Export failed' });
  }
});

// ════════════════════════════════════════════════════════════
// SECURITY
// ════════════════════════════════════════════════════════════

// GET /admin/security
router.get('/security', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');

    // Banned users count
    const { count: bannedUsers } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_banned', true);

    // Pending reports count
    let pendingReports = 0;
    try {
      const reports = JSON.parse(fs.readFileSync(reportsPath));
      pendingReports = reports.filter(r => r.status === 'pending').length;
    } catch (_) {}

    // Active sessions (online users)
    const onlineUsers = req.app.get('onlineUsers');
    const activeSessions = onlineUsers ? onlineUsers.size : 0;

    return res.json({
      failed_logins_24h: 0,
      active_sessions: activeSessions,
      banned_users: bannedUsers || 0,
      pending_reports: pendingReports,
      alerts: [],
    });
  } catch (err) {
    console.error('Security error:', err);
    return res.status(500).json({ error: 'Failed to load security data' });
  }
});

module.exports = router;

