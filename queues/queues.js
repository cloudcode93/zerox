'use strict';

const { Queue } = require('bullmq');
const { getRedis } = require('../config/redis');
const logger = require('../config/logger');

/**
 * BullMQ Queue Definitions — Production-Grade
 * 
 * Features:
 *   - Queue size limits (prevent Redis memory explosion)
 *   - Priority levels (critical jobs processed first)
 *   - Job throttling via limiter
 *   - Deduplication via jobId
 *   - Exponential backoff retries
 */

// ═══════════════════════════════════════
// JOB PRIORITIES (lower = higher priority)
// ═══════════════════════════════════════
const PRIORITY = {
  CRITICAL: 1,     // Chat push notifications
  HIGH: 3,         // Interest/follow notifications
  NORMAL: 5,       // Like/comment notifications  
  LOW: 10,         // Cleanup, analytics
};

// ═══════════════════════════════════════
// QUEUE SIZE LIMITS
// ═══════════════════════════════════════
const QUEUE_LIMITS = {
  notifications: 5000,   // Max 5000 pending notification jobs
  cleanup: 100,          // Max 100 pending cleanup jobs
};

const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
};

// Lazy-initialized queue instances
let notificationQueue = null;
let cleanupQueue = null;

function getNotificationQueue() {
  if (!notificationQueue) {
    notificationQueue = new Queue('notifications', {
      connection: getRedis(),
      defaultJobOptions: {
        ...defaultJobOptions,
        priority: PRIORITY.NORMAL, // default priority
      },
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
        priority: PRIORITY.LOW,
      },
    });
    logger.info('[BullMQ] Cleanup queue initialized');
  }
  return cleanupQueue;
}

/**
 * Add a job with queue size protection.
 * Rejects new jobs if queue is at capacity — prevents Redis memory explosion.
 */
async function addJobSafe(queue, name, data, opts = {}) {
  const queueName = queue.name;
  const limit = QUEUE_LIMITS[queueName] || 5000;

  try {
    const waitingCount = await queue.getWaitingCount();
    if (waitingCount >= limit) {
      logger.warn(`[BullMQ] Queue "${queueName}" at capacity (${waitingCount}/${limit}), rejecting job`);
      return null; // Drop the job silently
    }

    return await queue.add(name, data, opts);
  } catch (err) {
    logger.error(`[BullMQ] Failed to add job to "${queueName}":`, err.message);
    return null;
  }
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
      jobId: 'daily-cleanup',
      priority: PRIORITY.LOW,
    });

    // Snapshot recording every 10 minutes
    await cleanup.add('record-snapshot', {}, {
      repeat: { pattern: '*/10 * * * *' },
      jobId: 'record-snapshot',
      priority: PRIORITY.LOW,
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
  addJobSafe,
  scheduleRepeatableJobs,
  closeQueues,
  PRIORITY,
};
