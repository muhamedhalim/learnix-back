import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import webpush from 'web-push';

import type { PushMessage, PushProvider, PushSendResult } from './push-provider.interface';
import { parseWebPushToken } from './web-push.util';

/** How long a push service keeps an undeliverable message (seconds). */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
/** Browsers reject payloads above ~4 KB; stay clearly below. */
const MAX_PAYLOAD_BYTES = 3_500;

/**
 * Standard Web Push (RFC 8030 + VAPID) behind `PushProvider`. Replaces FCM for browser clients:
 * no Firebase project, no vendor SDK in the browser, only a VAPID key pair held in Secrets Manager.
 * Failure classification matters here exactly as it does for FCM: 404/410 mean the subscription is
 * gone (disable that device only); everything else keeps the device.
 */
@Injectable()
export class WebPushProvider implements PushProvider {
  public readonly name = 'webpush';
  private readonly logger = new Logger(WebPushProvider.name);
  // ES private field: not an own property, so JSON.stringify / util.inspect / structured logging of
  // this object can never print the VAPID private key.
  readonly #details: { subject: string; publicKey: string; privateKey: string } | null;

  constructor(config: ConfigService) {
    const publicKey = config.get<string>('VAPID_PUBLIC_KEY')?.trim() ?? '';
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY')?.trim() ?? '';
    const subject = config.get<string>('VAPID_SUBJECT')?.trim() ?? '';
    this.#details =
      publicKey !== '' && privateKey !== '' && subject !== '' ? { subject, publicKey, privateKey } : null;
    if (this.#details === null) {
      this.logger.warn('Web Push is not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)');
    }
  }

  public isConfigured(): boolean {
    return this.#details !== null;
  }

  /** Exposed to browsers so they can subscribe; the private key never leaves this class. */
  public get publicKey(): string | null {
    return this.#details?.publicKey ?? null;
  }

  public async sendEach(messages: PushMessage[]): Promise<PushSendResult[]> {
    const details = this.#details;
    return await Promise.all(
      messages.map(async (message): Promise<PushSendResult> => {
        if (details === null) {
          return { token: message.token, accepted: false, error: 'Web Push is not configured', retryable: false };
        }
        const subscription = parseWebPushToken(message.token);
        if (subscription === null) {
          // Corrupt or non-allowlisted subscription: it can never succeed, so retire the device.
          return { token: message.token, accepted: false, error: 'Invalid push subscription', tokenInvalid: true };
        }
        const payload = this.payload(message);
        if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
          return { token: message.token, accepted: false, error: 'Push payload too large', retryable: false };
        }
        try {
          const response = await webpush.sendNotification(subscription, payload, {
            vapidDetails: details,
            TTL: DEFAULT_TTL_SECONDS,
            urgency: 'normal',
            ...(message.collapseKey !== undefined ? { topic: this.topic(message.collapseKey) } : {}),
            timeout: 10_000,
          });
          return {
            token: message.token,
            accepted: true,
            ...(typeof response.headers['location'] === 'string'
              ? { providerMessageId: response.headers['location'] }
              : {}),
          };
        } catch (error) {
          return this.toFailure(message.token, error);
        }
      }),
    );
  }

  private payload(message: PushMessage): string {
    const tag = message.collapseKey ?? message.data['notification_id'];
    return JSON.stringify({
      title: message.title,
      body: message.body,
      data: message.data,
      ...(tag !== undefined ? { tag } : {}),
    });
  }

  /** The Topic header must be <= 32 chars of URL-safe base64 characters. */
  private topic(collapseKey: string): string {
    return collapseKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'learnix';
  }

  private toFailure(token: string, error: unknown): PushSendResult {
    const status = (error as { statusCode?: number }).statusCode;
    const reason = error instanceof Error ? error.message : 'Web Push send failed';
    // The subscription is permanently gone (unsubscribed, expired, app data cleared).
    if (status === 404 || status === 410) {
      return { token, accepted: false, error: `Subscription expired (${String(status)})`, tokenInvalid: true };
    }
    // Throttled or the push service had a problem: worth another attempt, keep the device.
    if (status === undefined || status === 429 || status >= 500) {
      this.logger.warn(`Web Push transient failure (${String(status ?? 'network')}): ${reason}`);
      return { token, accepted: false, error: reason, retryable: true };
    }
    // 400/401/403/413: our request was rejected (bad VAPID, payload). Not the user's fault, not retryable.
    this.logger.error(`Web Push rejected (${String(status)}): ${reason}`);
    return { token, accepted: false, error: `Rejected (${String(status)})`, retryable: false };
  }
}
