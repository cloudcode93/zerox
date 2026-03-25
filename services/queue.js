/**
 * BullMQ Queue Definitions
 * Queues: notifications, analytics
 * All queues share the same Redis connection
 */
const { Queue } = require('bullmq');

let notificationQueue = null;
let analyticsQueue = null;

function init(redisConnection) {
  if (!redisConnection) {
    console.warn('[Queue] No Redis connection — queues disabled (inline fallback)');
    return;
  }

  const opts = { connection: redisConnection };

  notificationQueue = new Queue('notifications', opts);
  analyticsQueue = new Queue('analytics', opts);

  console.log('[Queue] BullMQ queues initialized: notifications, analytics');
}

function getNotificationQueue() { return notificationQueue; }
function getAnalyticsQueue() { return analyticsQueue; }

module.exports = { init, getNotificationQueue, getAnalyticsQueue };
