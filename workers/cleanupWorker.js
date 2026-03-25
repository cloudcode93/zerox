'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const logger = require('../config/logger');
const supabase = require('../config/supabase');
const { getRedis } = require('../config/redis');

/**
 * Cleanup Worker
 * 
 * Handles:
 *   - daily-cleanup: Purge old notifications, messages, soft-deleted ideas
 *   - record-snapshot: Record online user count every 10 minutes
 */

let worker = null;

function startCleanupWorker() {
  if (worker) return worker;

  worker = new Worker(
    'cleanup',
    async (job) => {
      switch (job.name) {
        case 'daily-cleanup':
          return await handleDailyCleanup();
        case 'record-snapshot':
          return await handleRecordSnapshot();
        default:
          logger.warn(`[CleanupWorker] Unknown job: ${job.name}`);
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 1, // Cleanup jobs should run sequentially
    }
  );

  worker.on('completed', (job, result) => {
    logger.debug(`[CleanupWorker] Job ${job.name} completed`, result);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[CleanupWorker] Job ${job?.name} failed:`, err.message);
  });

  logger.info('[CleanupWorker] Started');
  return worker;
}

async function handleDailyCleanup() {
  logger.info('[CleanupWorker] Running daily cleanup...');

  const NOTIF_DAYS = 7;
  const MSG_DAYS = 30;
  const DELETED_IDEA_DAYS = 30;

  const notifThreshold = new Date(Date.now() - NOTIF_DAYS * 86400000).toISOString();
  const msgThreshold = new Date(Date.now() - MSG_DAYS * 86400000).toISOString();
  const ideaThreshold = new Date(Date.now() - DELETED_IDEA_DAYS * 86400000).toISOString();
  const snapshotThreshold = new Date(Date.now() - 7 * 86400000).toISOString();

  const results = {};

  // Delete old notifications
  const { data: deletedNotifs, error: notifErr } = await supabase
    .from('notifications')
    .delete()
    .lt('created_at', notifThreshold)
    .select('id');
  results.notifications = notifErr ? 'error' : (deletedNotifs || []).length;

  // Delete old messages
  const { data: deletedMsgs, error: msgErr } = await supabase
    .from('messages')
    .delete()
    .lt('created_at', msgThreshold)
    .select('id');
  results.messages = msgErr ? 'error' : (deletedMsgs || []).length;

  // Permanently delete soft-deleted ideas
  const { data: deletedIdeas, error: ideaErr } = await supabase
    .from('ideas')
    .delete()
    .eq('is_deleted', true)
    .lt('updated_at', ideaThreshold)
    .select('id');
  results.ideas = ideaErr ? 'error' : (deletedIdeas || []).length;

  // Clean old snapshots
  await supabase.from('online_user_snapshots').delete().lt('recorded_at', snapshotThreshold);

  logger.info('[CleanupWorker] Daily cleanup complete', results);
  return results;
}

async function handleRecordSnapshot() {
  try {
    const redis = getRedis();
    // Get online user count from Redis hash
    const count = await redis.hlen('zerox:online_users');

    const { error } = await supabase
      .from('online_user_snapshots')
      .insert({ user_count: count });

    if (error && error.code === '42P01') {
      // Table doesn't exist — silently skip
      logger.debug('[CleanupWorker] online_user_snapshots table not found, skipping');
      return { skipped: true };
    }

    logger.debug(`[CleanupWorker] Snapshot recorded: ${count} users online`);
    return { count };
  } catch (err) {
    logger.error('[CleanupWorker] Snapshot error:', err.message);
    throw err;
  }
}

async function stopCleanupWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[CleanupWorker] Stopped');
  }
}

module.exports = { startCleanupWorker, stopCleanupWorker };
