/**
 * Lifecycle of one outbound guardian message.
 *
 * The distinction between SENT and DELIVERED is load-bearing and was the
 * subject of a real bug: the old SMS code stamped `delivered_at` the instant
 * Twilio *accepted* the message, so the delivery metric read ~100% even when
 * every message silently failed. Only a provider webhook may promote a row past
 * SENT.
 */
export enum ParentMessageStatus {
  /** Row created, job enqueued, nothing sent yet. */
  QUEUED = 'queued',
  /** The provider accepted the message for delivery. Not proof of receipt. */
  SENT = 'sent',
  /** The provider confirmed handset delivery (webhook). */
  DELIVERED = 'delivered',
  /** The guardian opened it (WhatsApp only; SMS has no read receipt). */
  READ = 'read',
  /** A delivery attempt failed; the job may still retry. */
  FAILED = 'failed',
  /** Every retry exhausted. Parked on the dead-letter queue for an admin. */
  DEAD = 'dead',
}
