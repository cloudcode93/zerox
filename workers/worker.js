/**
 * BullMQ Workers — runs in-process on each Render instance
 * Processes: push notifications, analytics snapshots
 * Concurrency: 5 parallel jobs
 */
const { Worker } = require('bullmq');
const admin = require('firebase-admin');

let notificationWorker = null;
let analyticsWorker = null;

function init(redisConnection, supabase) {
  if (!redisConnection) {
    console.warn('[Worker] No Redis connection — workers disabled');
    return;
  }

  const opts = { connection: redisConnection, concurrency: 5 };

  // ── Notification Worker ──
  notificationWorker = new Worker('notifications', async (job) => {
    const { type, data } = job.data;

    if (type === 'fcm_push') {
      const { userId, title, body, payload } = data;
      try {
        const { data: tokens, error } = await supabase
          .from('device_tokens')
          .select('fcm_token')
          .eq('user_id', userId);

        if (error || !tokens || tokens.length === 0) return;

        const invalidTokens = [];

        for (const tokenRow of tokens) {
          try {
            await admin.messaging().send({
              token: tokenRow.fcm_token,
              notification: { title, body },
              data: {
                ...payload,
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
              },
              android: {
                priority: 'high',
                notification: {
                  channelId: 'zerox_notifications',
                  priority: 'high',
                  sound: 'default',
                },
              },
            });
          } catch (sendError) {
            if (
              sendError.code === 'messaging/invalid-registration-token' ||
              sendError.code === 'messaging/registration-token-not-registered'
            ) {
              invalidTokens.push(tokenRow.fcm_token);
            }
          }
        }

        // Cleanup invalid tokens
        if (invalidTokens.length > 0) {
          await supabase.from('device_tokens').delete().in('fcm_token', invalidTokens);
        }
      } catch (err) {
        console.error('[Worker:notification] FCM error:', err.message);
        throw err; // BullMQ will retry
      }
    }
  }, opts);

  notificationWorker.on('completed', (job) => {
    // Silent on success
  });

  notificationWorker.on('failed', (job, err) => {
    console.error(`[Worker:notification] Job ${job?.id} failed:`, err.message);
  });

  // ── Analytics Worker ──
  analyticsWorker = new Worker('analytics', async (job) => {
    const { type, data } = job.data;

    if (type === 'online_snapshot') {
      try {
        await supabase
          .from('online_user_snapshots')
          .insert({ user_count: data.count });
      } catch (err) {
        console.error('[Worker:analytics] Snapshot error:', err.message);
      }
    }
  }, opts);

  analyticsWorker.on('failed', (job, err) => {
    console.error(`[Worker:analytics] Job ${job?.id} failed:`, err.message);
  });

  console.log('[Worker] BullMQ workers started: notifications, analytics');
}

async function shutdown() {
  const workers = [notificationWorker, analyticsWorker].filter(Boolean);
  await Promise.allSettled(workers.map(w => w.close()));
  console.log('[Worker] All workers stopped');
}

module.exports = { init, shutdown };
