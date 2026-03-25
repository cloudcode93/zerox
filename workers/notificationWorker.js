'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const logger = require('../config/logger');
const supabase = require('../config/supabase');
const admin = require('firebase-admin');

/**
 * Notification Worker
 * 
 * Processes queued push notification jobs.
 * Concurrency: 3 (3 notifications processed simultaneously)
 * 
 * Job data shape:
 *   { userId, title, body, data }
 * 
 * Deduplication: Jobs use a composite jobId (type:userId:referenceId)
 * to prevent duplicate notifications.
 */

let worker = null;

function startNotificationWorker() {
  if (worker) return worker;

  worker = new Worker(
    'notifications',
    async (job) => {
      const { userId, title, body, data: extraData = {} } = job.data;

      logger.info(`[NotifWorker] Processing job ${job.id}: ${title} → user ${userId}`);

      // Fetch user's FCM tokens
      const { data: tokens, error } = await supabase
        .from('device_tokens')
        .select('fcm_token')
        .eq('user_id', userId);

      if (error || !tokens || tokens.length === 0) {
        logger.debug(`[NotifWorker] No FCM tokens for user ${userId}, skipping`);
        return { skipped: true, reason: 'no_tokens' };
      }

      // Check if Firebase is initialized
      if (admin.apps.length === 0) {
        logger.warn('[NotifWorker] Firebase not initialized, skipping push');
        return { skipped: true, reason: 'firebase_not_initialized' };
      }

      const invalidTokens = [];
      let successCount = 0;

      for (const tokenRow of tokens) {
        try {
          await admin.messaging().send({
            token: tokenRow.fcm_token,
            notification: { title, body },
            data: {
              ...extraData,
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
          successCount++;
        } catch (sendError) {
          if (
            sendError.code === 'messaging/invalid-registration-token' ||
            sendError.code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(tokenRow.fcm_token);
          } else {
            logger.warn(`[NotifWorker] FCM send failed: ${sendError.code || sendError.message}`);
            throw sendError; // Re-throw to trigger BullMQ retry
          }
        }
      }

      // Cleanup invalid tokens
      if (invalidTokens.length > 0) {
        await supabase.from('device_tokens').delete().in('fcm_token', invalidTokens);
        logger.info(`[NotifWorker] Cleaned ${invalidTokens.length} invalid tokens`);
      }

      logger.info(`[NotifWorker] Delivered ${successCount}/${tokens.length} for user ${userId}`);
      return { success: successCount, failed: tokens.length - successCount - invalidTokens.length };
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
      limiter: {
        max: 50,
        duration: 10000, // Max 50 jobs per 10 seconds to avoid FCM throttling
      },
    }
  );

  worker.on('completed', (job, result) => {
    logger.debug(`[NotifWorker] Job ${job.id} completed`, result);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[NotifWorker] Job ${job?.id} failed:`, err.message);
  });

  logger.info('[NotifWorker] Started with concurrency 3');
  return worker;
}

async function stopNotificationWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[NotifWorker] Stopped');
  }
}

module.exports = { startNotificationWorker, stopNotificationWorker };
