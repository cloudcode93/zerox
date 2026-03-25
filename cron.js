'use strict';

/**
 * DEPRECATED: This file is no longer used.
 * 
 * All cron functionality has been migrated to BullMQ repeatable jobs:
 *   - Daily cleanup → workers/cleanupWorker.js
 *   - Snapshot recording → workers/cleanupWorker.js
 *   - Self-ping → REMOVED (Render handles its own health checks)
 * 
 * Jobs are scheduled in queues/queues.js → scheduleRepeatableJobs()
 * and started automatically in server.js on boot.
 * 
 * This file is kept only for reference. Safe to delete.
 */
