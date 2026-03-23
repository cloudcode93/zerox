const cron = require('node-cron');

module.exports = (supabase, onlineUsers) => {
  // ════════════════════════════════════════════════════════════
  // Daily cleanup at midnight — notifications, messages, soft-deleted ideas
  // ════════════════════════════════════════════════════════════
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Running daily cleanup...');
    try {
      // Configurable thresholds (days)
      const NOTIF_DAYS = 7;
      const MSG_DAYS = 30;
      const DELETED_IDEA_DAYS = 30;

      const notifThreshold = new Date(Date.now() - NOTIF_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const msgThreshold = new Date(Date.now() - MSG_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const ideaThreshold = new Date(Date.now() - DELETED_IDEA_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Delete old notifications
      const { data: deletedNotifs, error: notifErr } = await supabase
        .from('notifications')
        .delete()
        .lt('created_at', notifThreshold)
        .select('id');
      if (notifErr) console.error('[Cron] Failed to delete old notifications:', notifErr);
      else console.log(`[Cron] Deleted ${(deletedNotifs || []).length} notifications older than ${NOTIF_DAYS} days`);

      // Delete old messages
      const { data: deletedMsgs, error: msgErr } = await supabase
        .from('messages')
        .delete()
        .lt('created_at', msgThreshold)
        .select('id');
      if (msgErr) console.error('[Cron] Failed to delete old messages:', msgErr);
      else console.log(`[Cron] Deleted ${(deletedMsgs || []).length} messages older than ${MSG_DAYS} days`);

      // Permanently delete soft-deleted ideas
      const { data: deletedIdeas, error: ideaErr } = await supabase
        .from('ideas')
        .delete()
        .eq('is_deleted', true)
        .lt('updated_at', ideaThreshold)
        .select('id');
      if (ideaErr) console.error('[Cron] Failed to delete old soft-deleted ideas:', ideaErr);
      else console.log(`[Cron] Permanently deleted ${(deletedIdeas || []).length} soft-deleted ideas older than ${DELETED_IDEA_DAYS} days`);

      // Clean up old snapshots (keep last 7 days)
      const snapshotThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('online_user_snapshots').delete().lt('recorded_at', snapshotThreshold);

      console.log('[Cron] Daily cleanup complete.');
    } catch (err) {
      console.error('[Cron] Job Error:', err);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Every 10 minutes: Self-ping + Record online user snapshot
  // ════════════════════════════════════════════════════════════
  cron.schedule('*/10 * * * *', async () => {
    // Self-ping
    try {
      const url = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}/`;
      const protocol = url.startsWith('https') ? require('https') : require('http');
      
      protocol.get(url, (res) => {
        if (res.statusCode === 200) {
          console.log(`[Self-Ping] OK at ${url}`);
        } else {
          console.log(`[Self-Ping] Status: ${res.statusCode}`);
        }
      }).on('error', (err) => {
        console.error('[Self-Ping] Error:', err.message);
      });
    } catch (err) {
      console.error('[Self-Ping] Catch Error:', err);
    }

    // Record online user count snapshot
    try {
      const count = onlineUsers ? onlineUsers.size : 0;
      const { error } = await supabase
        .from('online_user_snapshots')
        .insert({ user_count: count });
      if (error) {
        // Table might not exist yet, try creating it
        if (error.code === '42P01') {
          console.log('[Cron] Creating online_user_snapshots table...');
          await supabase.rpc('exec_sql', {
            sql: `CREATE TABLE IF NOT EXISTS online_user_snapshots (
              id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              user_count integer NOT NULL DEFAULT 0,
              recorded_at timestamptz NOT NULL DEFAULT now()
            ); CREATE INDEX IF NOT EXISTS idx_snapshots_recorded_at ON online_user_snapshots(recorded_at DESC);`
          });
          // Retry insert
          await supabase.from('online_user_snapshots').insert({ user_count: count });
        } else {
          console.error('[Cron] Snapshot error:', error.message);
        }
      }
      console.log(`[Cron] Recorded snapshot: ${count} users online`);
    } catch (err) {
      console.error('[Cron] Snapshot error:', err);
    }
  });
};
