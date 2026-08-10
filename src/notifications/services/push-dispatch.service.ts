import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { maskSecret } from '../../common/utils/mask.util';
import {
  Notification,
  NotificationChannel,
  NotificationDeliveryStatus,
  type PushDevice,
} from '../entities';
import {
  PUSH_PROVIDER,
  type PushMessage,
  type PushProvider,
  type PushSendResult,
} from '../push/push-provider.interface';
import { NotificationChannelPolicyService } from './notification-channel-policy.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { PushDeviceService } from './push-device.service';

/** Aggregate outcome of pushing one notification to one user's devices. */
export interface PushDispatchOutcome {
  notificationId: string;
  /** Provider accepted this many device legs. */
  accepted: number;
  /** Devices disabled during this dispatch because the provider said so. */
  invalidated: number;
  /** Legs that failed transiently — the job should be retried. */
  retryable: number;
  status:
    | 'sent'
    | 'partial'
    | 'failed'
    | 'skipped_preference'
    | 'no_registered_device'
    | 'provider_unavailable';
}

/**
 * Push delivery: preference → devices → provider → records.
 *
 * This is the only place that turns a Learnix `Notification` into a push, and
 * it walks the DEF-005 pipeline in order, recording an outcome at every exit:
 *
 *   1. **Channel preference** (`push_enabled`). Off ⇒ record
 *      `skipped_preference` and return. No provider call, no device lookup —
 *      the switch stops the message, not just the report about it.
 *   2. **Provider configured.** Absent credentials ⇒ `provider_unavailable`.
 *      A deployment without Firebase must degrade to "push unavailable", never
 *      to an exception on an unrelated notification.
 *   3. **Devices.** None ⇒ `no_registered_device`, which is deliberately
 *      distinct from "sent": the user asked for push and got nothing, and that
 *      must be visible rather than indistinguishable from success.
 *   4. **Claim, send, record — per device.** Each device is an independent leg
 *      with its own `notification_deliveries` row, so partial success is the
 *      normal, correctly-recorded case.
 *
 * PARTIAL FAILURE, precisely. Three devices, two accepted, one permanently
 * invalid: the two acceptances are recorded terminal (a retry will not resend
 * them), the third device — and only the third — is disabled, and the job does
 * NOT throw, because retrying cannot resurrect a dead token. A *transient*
 * failure on the third would instead leave the device alone and throw, so BullMQ
 * retries it while the two terminal legs stay untouched.
 */
@Injectable()
export class PushDispatchService {
  private readonly logger = new Logger(PushDispatchService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    private readonly devices: PushDeviceService,
    private readonly policy: NotificationChannelPolicyService,
    private readonly deliveries: NotificationDeliveryService,
  ) {}

  /**
   * Push one already-persisted notification.
   *
   * @param attempt BullMQ attempt number, recorded on each leg.
   * @throws when at least one leg failed transiently, so the queue retries.
   */
  public async dispatch(notificationId: string, attempt = 1): Promise<PushDispatchOutcome> {
    const notification = await this.notifications.findOne({ where: { id: notificationId } });
    if (!notification) {
      this.logger.warn(`Push dispatch skipped: notification ${notificationId} no longer exists`);
      return { notificationId, accepted: 0, invalidated: 0, retryable: 0, status: 'failed' };
    }

    // 1 ── channel preference
    const decision = await this.policy.decide(notification.user_id, NotificationChannel.PUSH);
    if (!decision.allowed) {
      await this.deliveries.recordSkip(
        notification.id,
        NotificationChannel.PUSH,
        NotificationDeliveryStatus.SKIPPED_PREFERENCE,
        this.provider.name,
      );
      return {
        notificationId,
        accepted: 0,
        invalidated: 0,
        retryable: 0,
        status: 'skipped_preference',
      };
    }

    // 2 ── provider availability
    if (!this.provider.isConfigured()) {
      await this.deliveries.recordSkip(
        notification.id,
        NotificationChannel.PUSH,
        NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
        this.provider.name,
      );
      this.logger.warn(
        `Push provider ${this.provider.name} is not configured — notification ${notificationId} not pushed`,
      );
      return {
        notificationId,
        accepted: 0,
        invalidated: 0,
        retryable: 0,
        status: 'provider_unavailable',
      };
    }

    // 3 ── devices
    const devices = await this.devices.findActiveForUser(notification.user_id);
    if (devices.length === 0) {
      await this.deliveries.recordSkip(
        notification.id,
        NotificationChannel.PUSH,
        NotificationDeliveryStatus.NO_REGISTERED_DEVICE,
        this.provider.name,
      );
      return {
        notificationId,
        accepted: 0,
        invalidated: 0,
        retryable: 0,
        status: 'no_registered_device',
      };
    }

    // 4 ── claim each leg, then send only the ones we actually own
    const claimed: Array<{ device: PushDevice; deliveryId: string }> = [];
    for (const device of devices) {
      const claim = await this.deliveries.claim({
        notificationId: notification.id,
        channel: NotificationChannel.PUSH,
        pushDeviceId: device.id,
        provider: this.provider.name,
      });
      if (claim.claimed) claimed.push({ device, deliveryId: claim.delivery.id });
    }

    if (claimed.length === 0) {
      this.logger.debug(
        `Notification ${notificationId}: every device leg already terminal — nothing to resend`,
      );
      return { notificationId, accepted: 0, invalidated: 0, retryable: 0, status: 'sent' };
    }

    const payload = this.buildPayload(notification);
    const messages: PushMessage[] = claimed.map(({ device }) => ({
      ...payload,
      token: device.token,
    }));

    const results = await this.provider.sendEach(messages);

    let accepted = 0;
    let invalidated = 0;
    let retryable = 0;

    for (const [index, leg] of claimed.entries()) {
      const result = results[index];
      const outcome = await this.applyResult(leg, result, attempt);
      if (outcome === 'accepted') accepted++;
      else if (outcome === 'invalidated') invalidated++;
      else retryable++;
    }

    this.logger.log(
      `Push ${notificationId}: ${String(accepted)}/${String(claimed.length)} accepted by ` +
        `${this.provider.name}` +
        (invalidated > 0 ? `, ${String(invalidated)} token(s) invalidated` : '') +
        (retryable > 0 ? `, ${String(retryable)} retryable failure(s)` : ''),
    );

    if (retryable > 0) {
      // Throwing hands the job back to BullMQ. The accepted legs are already
      // terminal, so the retry re-attempts only what actually failed.
      throw new Error(
        `Push transient failure for ${String(retryable)} device(s) of notification ${notificationId}`,
      );
    }

    return {
      notificationId,
      accepted,
      invalidated,
      retryable,
      status: accepted === 0 ? 'failed' : accepted === claimed.length ? 'sent' : 'partial',
    };
  }

  private async applyResult(
    leg: { device: PushDevice; deliveryId: string },
    result: PushSendResult | undefined,
    attempt: number,
  ): Promise<'accepted' | 'invalidated' | 'retryable'> {
    if (result === undefined) {
      await this.deliveries.record(leg.deliveryId, NotificationDeliveryStatus.FAILED, {
        provider: this.provider.name,
        error: 'No provider response',
        attempt,
      });
      await this.devices.recordFailure(leg.device.id, 'No provider response');
      return 'retryable';
    }

    if (result.accepted) {
      await this.deliveries.record(leg.deliveryId, NotificationDeliveryStatus.SENT, {
        provider: this.provider.name,
        providerMessageId: result.providerMessageId ?? null,
        attempt,
      });
      await this.devices.recordSuccess(leg.device.id);
      return 'accepted';
    }

    const reason = result.error ?? 'Push delivery failed';

    if (result.tokenInvalid === true) {
      // Permanently dead token: disable THIS device only. The other legs of the
      // same notification are unaffected — they have their own rows and their
      // own devices.
      await this.deliveries.record(leg.deliveryId, NotificationDeliveryStatus.INVALID_TOKEN, {
        provider: this.provider.name,
        error: reason,
        attempt,
      });
      await this.devices.invalidate(leg.device.id, reason);
      this.logger.warn(
        `Disabled push device ${leg.device.id} (${maskSecret(leg.device.token) ?? '***'}): ${reason}`,
      );
      return 'invalidated';
    }

    await this.deliveries.record(leg.deliveryId, NotificationDeliveryStatus.FAILED, {
      provider: this.provider.name,
      error: reason,
      attempt,
    });
    await this.devices.recordFailure(leg.device.id, reason);
    return 'retryable';
  }

  /**
   * Notification → push payload.
   *
   * Carries identifiers and a deep link, not content: the body is the same
   * short summary already stored on the in-app notification, and anything the
   * client needs beyond that it fetches from the authenticated API using
   * `notification_id`. Push payloads sit in the OS notification centre and in
   * provider logs, so grades, amounts and guardian contact details have no
   * business in one.
   *
   * `collapse_key` is the notification id, so a retried or re-emitted
   * notification replaces its predecessor on the device instead of stacking.
   */
  private buildPayload(notification: Notification): Omit<PushMessage, 'token'> {
    const data: Record<string, string> = {
      notification_id: notification.id,
      notification_type: notification.type,
      // Deep link into the in-app notification list; the client resolves the
      // specific target after authenticating.
      link: '/student/notifications',
    };

    const linkFromData = notification.data?.['link'];
    if (typeof linkFromData === 'string' && linkFromData.startsWith('/')) {
      data['link'] = linkFromData;
    }

    return {
      title: notification.title.slice(0, 120),
      body: notification.message.slice(0, 240),
      data,
      collapseKey: notification.id,
    };
  }
}
