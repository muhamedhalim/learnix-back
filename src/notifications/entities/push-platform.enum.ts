/**
 * Client platform a push registration belongs to.
 *
 * Persisted in `push_devices.platform`; part of the database contract.
 *
 * `WEB` is the only platform Learnix ships a client for today. ANDROID/IOS
 * exist because the device model must not have to change when a mobile client
 * appears — a token is a token, and the dispatcher never branches on platform.
 */
export enum PushPlatform {
  WEB = 'web',
  ANDROID = 'android',
  IOS = 'ios',
}

/** Push transport providers Learnix can register a token against. */
export enum PushProviderName {
  /** Firebase Cloud Messaging (HTTP v1, via the Firebase Admin SDK). */
  FCM = 'fcm',
  /** Standard Web Push (RFC 8030) with VAPID; the token is the browser's PushSubscription JSON. */
  WEBPUSH = 'webpush',
}

/**
 * Why a device stopped being a delivery target.
 *
 * Kept distinct from a plain boolean so an operator can tell "the user turned
 * this off" apart from "FCM told us the token is dead" — the second is normal
 * churn, the first is a consent decision.
 */
export enum PushDeviceDisabledReason {
  /** The user (or their client, on logout) unregistered this device. */
  USER_REVOKED = 'user_revoked',
  /** The provider reported the token as unregistered/invalid. */
  INVALID_TOKEN = 'invalid_token',
  /** The token was re-registered by another user on the same install. */
  REASSIGNED = 'reassigned',
}
