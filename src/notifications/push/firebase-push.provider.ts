import { Injectable, Logger } from '@nestjs/common';

import type { messaging } from 'firebase-admin';

import { maskSecret } from '../../common/utils/mask.util';
import { FirebaseService } from '../../firebase/firebase.service';
import type { PushMessage, PushProvider, PushSendResult } from './push-provider.interface';

/**
 * FCM error codes that mean "this token is dead — stop using it".
 *
 * Getting this set right is the difference between healthy churn and silently
 * unsubscribing users: anything NOT listed here is treated as retryable, so a
 * code we have not seen before can never cost someone their registration.
 *
 * `registration-token-not-registered` is the normal end of a token's life
 * (browser data cleared, permission revoked, app uninstalled).
 * `invalid-registration-token` / `invalid-argument` mean the string was never
 * usable — a client bug or a hand-edited request; retrying cannot fix either.
 * `sender-id-mismatch` means the token belongs to a different Firebase project,
 * which is what a staging token sent to production looks like.
 */
const PERMANENT_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'messaging/mismatched-credential',
  'messaging/sender-id-mismatch',
]);

/**
 * FCM error codes that are worth another attempt. Everything unrecognised
 * falls here too (see above), so the default is "keep the device".
 */
const RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/unavailable',
  'messaging/quota-exceeded',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/topics-message-rate-exceeded',
  'messaging/unknown-error',
]);

/**
 * Firebase Cloud Messaging, behind `PushProvider`.
 *
 * Uses `messaging().sendEach()`, which is the current multi-message API of the
 * Firebase Admin SDK v13 and speaks FCM HTTP v1. The deprecated legacy paths
 * (`sendToDevice`, the legacy FCM server-key HTTP API, and `sendMulticast`) are
 * deliberately not used.
 *
 * `sendEach` is per-message independent: it returns one `SendResponse` per input
 * in input order and never aborts the batch on a single failure, which is
 * exactly the semantic a multi-device user needs — two good handsets must still
 * receive the notification when the third holds a dead token.
 *
 * This class is the ONLY file in the notification pipeline that imports
 * anything Firebase-shaped.
 */
@Injectable()
export class FirebasePushProvider implements PushProvider {
  public readonly name = 'fcm';

  private readonly logger = new Logger(FirebasePushProvider.name);

  constructor(private readonly firebase: FirebaseService) {}

  public isConfigured(): boolean {
    return this.firebase.isConfigured();
  }

  public async sendEach(messages: PushMessage[]): Promise<PushSendResult[]> {
    if (messages.length === 0) return [];

    const client = this.firebase.getMessaging();
    if (client === null) {
      return messages.map((message) => ({
        token: message.token,
        accepted: false,
        error: 'Firebase Cloud Messaging is not configured',
        retryable: false,
      }));
    }

    let batch: messaging.BatchResponse;
    try {
      batch = await client.sendEach(messages.map((message) => this.toFcmMessage(message)));
    } catch (error: unknown) {
      // A whole-batch throw is an auth/transport problem, not a per-token
      // verdict. Report every message as retryable so no device is disabled on
      // the strength of a credential or network failure.
      const reason = error instanceof Error ? error.message : 'FCM batch send failed';
      this.logger.error(`FCM batch send failed for ${String(messages.length)} token(s): ${reason}`);
      return messages.map((message) => ({
        token: message.token,
        accepted: false,
        error: reason,
        retryable: true,
      }));
    }

    return messages.map((message, index) => this.toResult(message.token, batch.responses[index]));
  }

  private toFcmMessage(message: PushMessage): messaging.Message {
    // Same tag ⇒ the newer notification replaces the older one on the device
    // instead of stacking, which is what a user expects when e.g. an exam is
    // re-graded or a job retries.
    const tag = message.collapseKey ?? message.data['notification_id'];
    const link = message.data['link'];

    return {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      webpush: {
        notification: {
          title: message.title,
          body: message.body,
          ...(tag === undefined ? {} : { tag }),
        },
        fcmOptions: link !== undefined && link !== '' ? { link } : {},
      },
      android: {
        priority: 'high',
        ...(message.collapseKey === undefined ? {} : { collapseKey: message.collapseKey }),
      },
      apns: {
        payload: { aps: { sound: 'default' } },
        ...(message.collapseKey === undefined
          ? {}
          : { headers: { 'apns-collapse-id': message.collapseKey } }),
      },
    };
  }

  private toResult(token: string, response: messaging.SendResponse | undefined): PushSendResult {
    if (response === undefined) {
      // Cannot happen for a well-behaved SDK (one response per message), but a
      // missing entry must not be read as success.
      return { token, accepted: false, error: 'No provider response', retryable: true };
    }

    if (response.success) {
      return response.messageId === undefined
        ? { token, accepted: true }
        : { token, accepted: true, providerMessageId: response.messageId };
    }

    const code = response.error?.code ?? 'messaging/unknown-error';
    const reason = response.error?.message ?? 'FCM rejected the message';
    const permanent = PERMANENT_TOKEN_ERRORS.has(code);

    this.logger.warn(
      `FCM rejected token ${maskSecret(token) ?? '***'}: ${code}` +
        (permanent ? ' (token will be disabled)' : ' (retryable)'),
    );

    return {
      token,
      accepted: false,
      error: `${code}: ${reason}`,
      tokenInvalid: permanent,
      retryable: !permanent && (RETRYABLE_ERRORS.has(code) || !PERMANENT_TOKEN_ERRORS.has(code)),
    };
  }
}
