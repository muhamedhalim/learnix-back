/**
 * The push transport boundary.
 *
 * Everything above this interface — preference policy, device selection,
 * delivery records, retries, idempotency — is Learnix business logic and knows
 * nothing about Firebase. Everything below it is provider mechanics: auth,
 * payload shape, error-code translation. Swapping FCM for APNs, OneSignal or
 * Web Push/VAPID means adding one class and changing one `useClass`; no
 * notification business code moves.
 *
 * This mirrors the shape `ParentChannel` already establishes for guardian
 * transports, deliberately: the codebase should have one way of expressing "a
 * thing that can hand a message to an external provider".
 */

/** One message, addressed to exactly one registration token. */
export interface PushMessage {
  /** Provider registration token. Sensitive — never log it in full. */
  token: string;
  title: string;
  body: string;
  /**
   * Flat string map carried to the client. Navigation and identifiers only —
   * never grades, amounts, guardian phone numbers or anything else the client
   * should be fetching from the authenticated API instead.
   */
  data: Record<string, string>;
  /** Groups replaceable notifications on the device (FCM collapse key). */
  collapseKey?: string;
}

/**
 * Outcome of one send, for one token.
 *
 * `accepted` means the PROVIDER TOOK IT. FCM does not tell us whether a handset
 * ever displayed it, so nothing here may be reported to a user as "delivered".
 */
export interface PushSendResult {
  token: string;
  accepted: boolean;
  /** Provider-assigned id, for correlation in provider-side logs. */
  providerMessageId?: string;
  error?: string;
  /**
   * The provider says this token is permanently dead (uninstalled, permission
   * revoked, rotated). The device must be disabled — and only that device.
   */
  tokenInvalid?: boolean;
  /**
   * Transient (5xx, quota, timeout). Worth a retry; must NOT disable the
   * device, or one bad provider minute would silently unsubscribe a user.
   */
  retryable?: boolean;
}

export interface PushProvider {
  /** Stable provider identifier, persisted on the delivery record. */
  readonly name: string;
  /** False when credentials are absent — the dispatcher then records a skip. */
  isConfigured(): boolean;
  /**
   * Send each message independently and return one result per input, in input
   * order. A permanent failure for one token must never suppress the others:
   * partial success is the normal case for a multi-device user.
   */
  sendEach(messages: PushMessage[]): Promise<PushSendResult[]>;
}

/** DI token — `PushProvider` is an interface and cannot be injected by type. */
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
