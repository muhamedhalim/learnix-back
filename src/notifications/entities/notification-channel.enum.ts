/**
 * The transports a Learnix notification can travel over, and the identity of
 * each user-facing channel preference in `notification_settings`.
 *
 * IN_APP is deliberately absent: the `notifications` row *is* the in-app
 * notification, it is the durable record every other channel is derived from,
 * and it is therefore never suppressible by a preference. Turning every channel
 * off must still leave the user able to see what happened when they open the
 * app.
 *
 * The string values are persisted in `notification_deliveries.channel`, so they
 * are part of the database contract — rename with a migration, never in place.
 */
export enum NotificationChannel {
  SMS = 'sms',
  EMAIL = 'email',
  PUSH = 'push',
}

/** `notification_settings` column that governs each channel. */
export const CHANNEL_PREFERENCE_COLUMN: Readonly<Record<NotificationChannel, string>> =
  Object.freeze({
    [NotificationChannel.SMS]: 'sms_enabled',
    [NotificationChannel.EMAIL]: 'email_enabled',
    [NotificationChannel.PUSH]: 'push_enabled',
  });
