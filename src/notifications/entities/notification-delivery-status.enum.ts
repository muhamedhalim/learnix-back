/**
 * Outcome of ONE attempt to move ONE notification over ONE channel (and, for
 * push, to ONE device).
 *
 * The vocabulary is deliberately wider than the four-state
 * `NotificationStatus` on the parent row, because "nothing was sent" has
 * several distinct causes and collapsing them is exactly how DEF-005 stayed
 * invisible for so long: a user who disabled a channel and a user with no
 * registered handset both produced "no message", and neither was recorded.
 *
 * SENT means the PROVIDER ACCEPTED the message. It is not proof that a device
 * displayed it — FCM offers no such guarantee — and nothing in this codebase
 * may promote a row past SENT without a provider-side receipt.
 *
 * Persisted in `notification_deliveries.status`; part of the database contract.
 */
export enum NotificationDeliveryStatus {
  /** Row claimed, provider not yet called. */
  QUEUED = 'queued',
  /** The provider accepted the message. NOT proof of device delivery. */
  SENT = 'sent',
  /** The provider refused it, transiently or permanently. */
  FAILED = 'failed',
  /** The recipient has this channel switched off. No provider call was made. */
  SKIPPED_PREFERENCE = 'skipped_preference',
  /** Channel enabled, but the recipient has no usable target (no device). */
  NO_REGISTERED_DEVICE = 'no_registered_device',
  /** The provider reported this specific token as dead; the device was disabled. */
  INVALID_TOKEN = 'invalid_token',
  /** The transport provider is not configured in this deployment. */
  PROVIDER_UNAVAILABLE = 'provider_unavailable',
}

/** Statuses that must never be overwritten by a later attempt. */
export const TERMINAL_DELIVERY_STATUSES: ReadonlySet<NotificationDeliveryStatus> = new Set([
  NotificationDeliveryStatus.SENT,
  NotificationDeliveryStatus.SKIPPED_PREFERENCE,
  NotificationDeliveryStatus.INVALID_TOKEN,
]);
