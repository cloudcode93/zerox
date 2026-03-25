'use strict';

const admin = require('firebase-admin');
const logger = require('../config/logger');
const { getNotificationQueue, addJobSafe, PRIORITY } = require('../queues/queues');

/**
 * Centralized Notification Service
 * 
 * Flow:
 *   1. Insert notification into DB
 *   2. If user is online → deliver via Socket.IO (instant)
 *   3. If user is offline → queue FCM push via BullMQ (background)
 * 
 * The BullMQ worker handles the actual FCM delivery with retries,
 * rate limiting, and invalid token cleanup.
 */

/**
 * Queue a push notification for background delivery.
 * Uses addJobSafe() which checks queue size before adding.
 */
async function queuePushNotification(userId, title, body, data = {}) {
  try {
    const queue = getNotificationQueue();
    const jobId = `push:${userId}:${data.type || 'generic'}:${data.reference_id || Date.now()}`;

    // Determine priority based on notification type
    let priority = PRIORITY.NORMAL;
    if (data.type === 'chat_message') priority = PRIORITY.CRITICAL;
    else if (data.type === 'interest' || data.type === 'accept') priority = PRIORITY.HIGH;

    await addJobSafe(queue, 'send-push', {
      userId,
      title,
      body,
      data,
    }, {
      jobId,
      priority,
    });

    logger.debug(`[Notif] Queued push for user ${userId}: ${title} (priority: ${priority})`);
  } catch (err) {
    logger.error('[Notif] Failed to queue push notification:', err.message);
  }
}

/**
 * Direct FCM push (for critical real-time notifications like chat messages).
 * Bypasses the queue for lower latency.
 */
async function sendPushNotificationDirect(supabase, userId, title, body, data = {}) {
  try {
    if (admin.apps.length === 0) return;

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
            ...data,
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

    if (invalidTokens.length > 0) {
      await supabase.from('device_tokens').delete().in('fcm_token', invalidTokens);
    }
  } catch (err) {
    logger.error('[Notif] Direct push error:', err.message);
  }
}

/**
 * Create notification in DB and deliver via smart routing.
 */
async function createAndDeliverNotification(supabase, io, onlineUsers, {
  userId,
  actorId,
  type,
  referenceId,
  message,
}) {
  try {
    logger.debug(`[Notif] Creating: type=${type}, user=${userId}, actor=${actorId}`);

    // 1. Insert into notifications table
    const { data: notification, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        actor_id: actorId,
        type,
        reference_id: referenceId || null,
        message,
      })
      .select(`
        *,
        actor:users!notifications_actor_id_fkey(id, name, profile_image, role)
      `)
      .single();

    if (error) {
      logger.error('[Notif] DB insert failed:', error);
      return;
    }

    // 2. Smart delivery
    const recipientSocketId = await onlineUsers.get(userId);

    if (recipientSocketId) {
      // User is online → Socket.IO (instant)
      io.to(recipientSocketId).emit('new_notification', notification);
      logger.debug(`[Notif] Delivered via Socket.IO to user ${userId}`);
    } else {
      // User is offline → Queue FCM push (background)
      const title = _getNotificationTitle(type);
      await queuePushNotification(userId, title, message, {
        type,
        reference_id: referenceId || '',
        notification_id: notification.id,
      });
    }

    return notification;
  } catch (err) {
    logger.error('[Notif] createAndDeliverNotification error:', err.message);
  }
}

/**
 * Send push for chat message (no DB insert, uses direct path for latency).
 */
async function sendChatPushNotification(supabase, io, onlineUsers, {
  recipientId,
  senderName,
  messageText,
  chatId,
}) {
  const recipientSocketId = await onlineUsers.get(recipientId);
  if (!recipientSocketId) {
    // Use direct push for chat messages (lower latency than queue)
    await sendPushNotificationDirect(supabase, recipientId, senderName, messageText, {
      type: 'chat_message',
      chat_id: chatId,
    });
  }
}

function _getNotificationTitle(type) {
  switch (type) {
    case 'like': return 'New Like ❤️';
    case 'comment': return 'New Comment 💬';
    case 'follow': return 'New Follower 👤';
    case 'interest': return 'New Interest 🤝';
    case 'accept': return 'Interest Accepted ✅';
    case 'reject': return 'Interest Declined ❌';
    case 'message': return 'New Message 📩';
    default: return 'Zerox 🔔';
  }
}

module.exports = {
  queuePushNotification,
  sendPushNotificationDirect,
  createAndDeliverNotification,
  sendChatPushNotification,
};
