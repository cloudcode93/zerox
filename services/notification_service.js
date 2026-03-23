const admin = require('firebase-admin');

/**
 * Centralized Notification Service
 * Handles: DB insert + Socket.IO real-time + FCM push delivery
 * Features: structured logging, retry on transient failures
 */

/**
 * Send FCM push notification with retry
 */
async function sendPushNotification(supabase, userId, title, body, data = {}) {
  try {
    const { data: tokens, error } = await supabase
      .from('device_tokens')
      .select('fcm_token')
      .eq('user_id', userId);

    if (error || !tokens || tokens.length === 0) {
      console.log(`[Notif] No FCM tokens for user ${userId}`);
      return;
    }

    const invalidTokens = [];
    let successCount = 0;
    let failCount = 0;

    for (const tokenRow of tokens) {
      let sent = false;
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
          sent = true;
          successCount++;
          break; // Success, no retry needed
        } catch (sendError) {
          // Non-retryable errors — remove invalid tokens
          if (
            sendError.code === 'messaging/invalid-registration-token' ||
            sendError.code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(tokenRow.fcm_token);
            console.log(`[Notif] Invalid token removed for user ${userId}: ${sendError.code}`);
            break; // Don't retry invalid tokens
          }

          // Retryable — wait and try again
          console.log(`[Notif] FCM attempt ${attempt}/${maxRetries} failed for user ${userId}: ${sendError.code || sendError.message}`);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential: 1s, 2s
          } else {
            failCount++;
            console.error(`[Notif] FCM delivery FAILED after ${maxRetries} attempts for user ${userId}`);
          }
        }
      }
    }

    // Cleanup invalid tokens
    if (invalidTokens.length > 0) {
      await supabase
        .from('device_tokens')
        .delete()
        .in('fcm_token', invalidTokens);
      console.log(`[Notif] Removed ${invalidTokens.length} invalid FCM tokens`);
    }

    console.log(`[Notif] Push delivery for user ${userId}: ${successCount} success, ${failCount} failed`);
  } catch (err) {
    console.error('[Notif] sendPushNotification error:', err);
  }
}

/**
 * Create notification in DB and deliver via smart delivery
 */
async function createAndDeliverNotification(supabase, io, onlineUsers, {
  userId,
  actorId,
  type,
  referenceId,
  message,
}) {
  try {
    console.log(`[Notif] Creating: type=${type}, user=${userId}, actor=${actorId}`);

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
      console.error('[Notif] DB insert failed:', error);
      return;
    }

    console.log(`[Notif] DB insert OK: id=${notification.id}`);

    // 2. Smart delivery
    const recipientSocketId = onlineUsers.get(userId);

    if (recipientSocketId) {
      // User is online → deliver via Socket.IO
      io.to(recipientSocketId).emit('new_notification', notification);
      console.log(`[Notif] Delivered via Socket.IO to user ${userId}`);
    } else {
      // User is offline → send FCM push with retry
      const title = _getNotificationTitle(type);
      await sendPushNotification(supabase, userId, title, message, {
        type,
        reference_id: referenceId || '',
        notification_id: notification.id,
      });
      console.log(`[Notif] Delivered via FCM push to user ${userId}`);
    }

    return notification;
  } catch (err) {
    console.error('[Notif] createAndDeliverNotification error:', err);
  }
}

/**
 * Send push for chat message (no DB insert)
 */
async function sendChatPushNotification(supabase, io, onlineUsers, {
  recipientId,
  senderName,
  messageText,
  chatId,
}) {
  const recipientSocketId = onlineUsers.get(recipientId);
  if (!recipientSocketId) {
    console.log(`[Notif] Chat push: ${senderName} → user ${recipientId}`);
    await sendPushNotification(supabase, recipientId, `${senderName}`, messageText, {
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
  sendPushNotification,
  createAndDeliverNotification,
  sendChatPushNotification,
};
