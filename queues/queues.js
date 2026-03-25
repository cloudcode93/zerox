'use strict';

const { Queue } = require('bullmq');
const { getRedis } = require('../config/redis');
const logger = require('../config/logger');

/**
 * BullMQ Queue Definitions
 * 
 * All queues share the same Redis connection.
 * Default job options ensure reliability:
 *   - removeOnComplete: Keep last 100 completed jobs (for monitoring)
 *   - removeOnFail: Keep last 50 failed jobs (for debugging)
 *   - attempts: 3 retries with exponential backoff
 */

const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000, // 2s, 4s, 8s
  },
};

// Lazy-initialized queue instances
let notificationQueue = null;
let cleanupQueue = null;

function getNotificationQueue() {
  if (!notificationQueue) {
    notificationQueue = new Queue('notifications', {
      connection: getRedis(),
      defaultJobOptions,
    });
    logger.info('[BullMQ] Notification queue initialized');
  }
  return notificationQueue;
}

function getCleanupQueue() {
  if (!cleanupQueue) {
    cleanupQueue = new Queue('cleanup', {
      connection: getRedis(),
      defaultJobOptions: {
        ...defaultJobOptions,
        attempts: 2,
      },
    });
    logger.info('[BullMQ] Cleanup queue initialized');
  }
  return cleanupQueue;
}

/**
 * Schedule repeatable cleanup jobs (replaces node-cron).
 * Call once at startup.
 */
async function scheduleRepeatableJobs() {
  try {
    const cleanup = getCleanupQueue();

    // Daily cleanup at midnight UTC
    await cleanup.add('daily-cleanup', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'daily-cleanup',  // Prevents duplicate scheduling
    });

    // Snapshot recording every 10 minutes
    await cleanup.add('record-snapshot', {}, {
      repeat: { pattern: '*/10 * * * *' },
      jobId: 'record-snapshot',
    });

    logger.info('[BullMQ] Repeatable jobs scheduled');
  } catch (err) {
    logger.error('[BullMQ] Failed to schedule repeatable jobs:', err.message);
  }
}

/**
 * Close all queues gracefully.
 */
async function closeQueues() {
  const promises = [];
  if (notificationQueue) promises.push(notificationQueue.close());
  if (cleanupQueue) promises.push(cleanupQueue.close());
  await Promise.allSettled(promises);
  logger.info('[BullMQ] All queues closed');
}

module.exports = {
  getNotificationQueue,
  getCleanupQueue,
  scheduleRepeatableJobs,
  closeQueues,
};
