/**
 * Cron Jobs — Multi-server safe with distributed locking
 * Only one of the 3 instances runs each job; others skip.
 */
const cron = require('node-cron');
const { getRedis, getIsConnected } = require('./services/redis');

module.exports = (supabase, onlineUsersService, queueService, cache, INSTANCE_ID) => {

  /**
   * Distributed lock: only one server runs the job.
   * Uses Redis SET NX (set-if-not-exists) with TTL.
   */
  async function acquireLock(lockName, ttlSeconds = 300) {
    try {
      const redis = getRedis();
      if (redis && getIsConnected()) {
        const result = await redis.set(`lock:${lockName}`, process.pid.toString(), 'EX', ttlSeconds, 'NX');
        return result === 'OK';
      }
    } catch (err) { /* silent */ }
    // If no Redis, always run (single-instance fallback)
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // Server Load Monitoring (Every 1 minute, EVERY instance)
  // No lock check here — we want all instances to report their health
  // ════════════════════════════════════════════════════════════
  cron.schedule('* * * * *', async () => {
    try {
      const redis = getRedis();
      if (!redis || !getIsConnected()) return; // Requires Redis

      const memUsage = process.memoryUsage();
      const memUsedMb = Math.round(memUsage.rss / 1024 / 1024);
      const os = require('os');
      const loadAvg = os.loadavg()[0]; // 1-minute load average
      const timestamp = new Date().toISOString();

      const metrics = {
        timestamp,
        memory_used_mb: memUsedMb,
        cpu_load: parseFloat(loadAvg.toFixed(2)),
      };

      // 1. Maintain list of active instances (expires after 3 minutes if instance dies)
      await redis.set(`instance_active:${INSTANCE_ID}`, 'true', 'EX', 180);
      
      // 2. Store current status in a hash
      await redis.hset('server_health', INSTANCE_ID, JSON.stringify({
        status: 'Online',
        updated_at: timestamp,
        memory_used_mb: memUsedMb,
        cpu_load: metrics.cpu_load,
        uptime_hours: (process.uptime() / 3600).toFixed(1),
        node_version: process.version
      }));

      // 3. Push to historical metrics list and trim to last 60 entries (1 hour)
      await redis.lpush(`metrics:${INSTANCE_ID}`, JSON.stringify(metrics));
      await redis.ltrim(`metrics:${INSTANCE_ID}`, 0, 59);

    } catch (err) {
      console.error(`[Cron] Metrics collection error on ${INSTANCE_ID}:`, err.message);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Daily cleanup at midnight
  // ════════════════════════════════════════════════════════════
  cron.schedule('0 0 * * *', async () => {
    if (!(await acquireLock('daily_cleanup', 600))) {
      console.log('[Cron] Skipping daily cleanup — another instance has the lock');
      return;
    }

    console.log('[Cron] Running daily cleanup...');
    try {
      const NOTIF_DAYS = 7;
      const MSG_DAYS = 30;
      const DELETED_IDEA_DAYS = 30;

      const notifThreshold = new Date(Date.now() - NOTIF_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const msgThreshold = new Date(Date.now() - MSG_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const ideaThreshold = new Date(Date.now() - DELETED_IDEA_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Delete old notifications
      const { data: deletedNotifs } = await supabase
        .from('notifications').delete().lt('created_at', notifThreshold).select('id');
      console.log(`[Cron] Deleted ${(deletedNotifs || []).length} old notifications`);

      // Delete old messages
      const { data: deletedMsgs } = await supabase
        .from('messages').delete().lt('created_at', msgThreshold).select('id');
      console.log(`[Cron] Deleted ${(deletedMsgs || []).length} old messages`);

      // Permanently delete soft-deleted ideas
      const { data: deletedIdeas } = await supabase
        .from('ideas').delete().eq('is_deleted', true).lt('updated_at', ideaThreshold).select('id');
      console.log(`[Cron] Permanently deleted ${(deletedIdeas || []).length} soft-deleted ideas`);

      // Clean up old snapshots
      const snapshotThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('online_user_snapshots').delete().lt('recorded_at', snapshotThreshold);

      // Clean up inactive servers from Redis Hash
      const redis = getRedis();
      if (redis && getIsConnected()) {
        const servers = await redis.hkeys('server_health');
        for (const serverId of servers) {
          const isActive = await redis.get(`instance_active:${serverId}`);
          if (!isActive) {
            await redis.hdel('server_health', serverId);
            await redis.del(`metrics:${serverId}`);
          }
        }
      }

      console.log('[Cron] Daily cleanup complete.');
    } catch (err) {
      console.error('[Cron] Cleanup error:', err);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Every 60 seconds: Cache warming (popular users, trending)
  // ════════════════════════════════════════════════════════════
  cron.schedule('* * * * *', async () => {
    if (!(await acquireLock('cache_warm', 55))) return;

    try {
      const { data: popularUsers } = await supabase
        .from('users').select('id, name, profile_image, role, followers_count')
        .eq('is_banned', false).order('followers_count', { ascending: false }).limit(10);

      if (popularUsers) await cache.set('popular_users', popularUsers, 120);
    } catch (err) { console.error('[Cron] Cache warm error:', err.message); }
  });

  // ════════════════════════════════════════════════════════════
  // Every 10 minutes: Record online user snapshot
  // ════════════════════════════════════════════════════════════
  cron.schedule('*/10 * * * *', async () => {
    if (!(await acquireLock('snapshot', 540))) return;

    try {
      const count = await onlineUsersService.getOnlineUserCount();
      const analyticsQueue = queueService.getAnalyticsQueue();

      if (analyticsQueue) {
        await analyticsQueue.add('snapshot', { type: 'online_snapshot', data: { count } }, { removeOnComplete: true });
      } else {
        await supabase.from('online_user_snapshots').insert({ user_count: count });
      }

      console.log(`[Cron] Online users: ${count}`);
    } catch (err) { console.error('[Cron] Snapshot error:', err.message); }
  });

  // ════════════════════════════════════════════════════════════
  // Every 10 minutes: Keep-Awake Ping for all instances
  // ════════════════════════════════════════════════════════════
  cron.schedule('*/10 * * * *', async () => {
    if (!(await acquireLock('keep_awake', 500))) return;

    const urls = (process.env.PING_URLS || process.env.SERVER_URL || '')
      .split(',').map(u => u.trim()).filter(u => u.startsWith('http'));

    if (urls.length > 0) {
      console.log(`[Cron] Pinging ${urls.length} instances to keep them awake...`);
      for (const url of urls) {
        try {
          const httpModule = url.startsWith('https') ? require('https') : require('http');
          httpModule.get(url).on('error', () => {}); // Catch silent errors
        } catch (e) { /* ignore */ }
      }
    }
  });
};
