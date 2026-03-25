const admin = require('firebase-admin');

/**
 * Centralized Notification Service
 * Handles: DB insert + Socket.IO real-time + FCM push delivery
 * Updated for multi-server: uses Redis for online user checks, BullMQ for async delivery
 */

/**
 * Send FCM push notification with retry (inline — used only as queue fallback)
 */
async function sendPushNotification(supabase, userId, title, body, data = {}) {
  try {
    const { data: tokens, error } = await supabase
      .from('device_tokens')
      .select('fcm_token')
      .eq('user_id', userId);

    if (error || !tokens || tokens.length === 0) return;

    const invalidTokens = [];

    for (const tokenRow of tokens) {
      const maxRetries = 2;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
          break;
        } catch (sendError) {
          if (
            sendError.code === 'messaging/invalid-registration-token' ||
            sendError.code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(tokenRow.fcm_token);
            break;
          }
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        }
      }
    }

    if (invalidTokens.length > 0) {
      await supabase.from('device_tokens').delete().in('fcm_token', invalidTokens);
    }
  } catch (err) {
    console.error('[Notif] sendPushNotification error:', err.message);
  }
}

/**
 * Create notification in DB and deliver via smart delivery
 * Supports both Redis-based and local-Map based online user checks
 */
async function createAndDeliverNotification(supabase, io, onlineUsers, {
  userId, actorId, type, referenceId, message,
}, options = {}) {
  try {
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
      .select(`*, actor:users!notifications_actor_id_fkey(id, name, profile_image, role)`)
      .single();

    if (error) {
      console.error('[Notif] DB insert failed:', error);
      return;
    }

    // 2. Smart delivery: check if user is online
    let isOnline = false;
    const isUserOnlineFn = options.isUserOnline;

    if (isUserOnlineFn) {
      // Redis-based check (works across all 3 servers)
      isOnline = await isUserOnlineFn(userId);
    } else {
      // Fallback to local Map
      isOnline = onlineUsers && onlineUsers.has(userId);
    }

    if (isOnline) {
      // User is online → emit via Socket.IO (Redis adapter broadcasts across instances)
      io.emit('new_notification_' + userId, notification);
      // Also try direct socket delivery
      const socketId = onlineUsers && onlineUsers.get(userId);
      if (socketId) {
        io.to(socketId).emit('new_notification', notification);
      }
    } else {
      // User is offline → queue or inline push
      const queue = options.notificationQueue;
      if (queue) {
        await queue.add('push', {
          type: 'fcm_push',
          data: {
            userId,
            title: _getNotificationTitle(type),
            body: message,
            payload: { type, reference_id: referenceId || '', notification_id: notification.id },
          },
        }, { removeOnComplete: true, removeOnFail: 50 });
      } else {
        await sendPushNotification(supabase, userId, _getNotificationTitle(type), message, {
          type, reference_id: referenceId || '', notification_id: notification.id,
        });
      }
    }

    return notification;
  } catch (err) {
    console.error('[Notif] createAndDeliverNotification error:', err.message);
  }
}

/**
 * Send push for chat message (no DB insert)
 */
async function sendChatPushNotification(supabase, io, onlineUsers, {
  recipientId, senderName, messageText, chatId,
}) {
  // Check if online (local fallback)
  const recipientSocketId = onlineUsers && onlineUsers.get(recipientId);
  if (!recipientSocketId) {
    await sendPushNotification(supabase, recipientId, senderName, messageText, {
      type: 'chat_message', chat_id: chatId,
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
  sendPushNotification,
  createAndDeliverNotification,
  sendChatPushNotification,
};
