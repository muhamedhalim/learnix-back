import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import {
  NotificationChannel,
  NotificationDelivery,
  NotificationDeliveryStatus,
  TERMINAL_DELIVERY_STATUSES,
} from '../entities';

export interface DeliveryClaimInput {
  notificationId: string;
  channel: NotificationChannel;
  /** Push only — one leg per device. */
  pushDeviceId?: string | null;
  provider?: string | null;
  requestPayload?: Record<string, unknown> | null;
}

export interface DeliveryClaimResult {
  /** False when this leg already reached a terminal status — do not send. */
  claimed: boolean;
  delivery: NotificationDelivery;
}

/**
 * Per-channel delivery records, and the idempotency they buy.
 *
 * `claim()` inserts the row BEFORE any provider is contacted, exactly as
 * `ParentMessageService.claim()` does for guardian messages. Postgres' UNIQUE
 * index on `dedupe_key` is the arbiter, so:
 *
 *  - a BullMQ retry of a job that already sent finds the row and stops;
 *  - two workers racing the same job collide on the index, and one wins;
 *  - a job that sent to two of three devices and then crashed re-attempts only
 *    the third, because the first two legs are already terminal.
 *
 * That last property is what makes "one invalid token does not cost the other
 * devices their notification" true across retries and not just within one pass.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    @InjectRepository(NotificationDelivery)
    private readonly deliveries: Repository<NotificationDelivery>,
  ) {}

  /** `<notification>:<channel>:<device | '-'>` — stable across retries. */
  public static dedupeKey(
    notificationId: string,
    channel: NotificationChannel,
    pushDeviceId?: string | null,
  ): string {
    return `${notificationId}:${channel}:${pushDeviceId ?? '-'}`;
  }

  public async claim(input: DeliveryClaimInput): Promise<DeliveryClaimResult> {
    const key = NotificationDeliveryService.dedupeKey(
      input.notificationId,
      input.channel,
      input.pushDeviceId,
    );

    const values: Partial<NotificationDelivery> = {
      dedupe_key: key,
      notification_id: input.notificationId,
      channel: input.channel,
      status: NotificationDeliveryStatus.QUEUED,
      provider: input.provider ?? null,
      push_device_id: input.pushDeviceId ?? null,
      request_payload: input.requestPayload ?? null,
    };

    const insert = await this.deliveries
      .createQueryBuilder()
      .insert()
      .into(NotificationDelivery)
      .values(values as QueryDeepPartialEntity<NotificationDelivery>)
      .orIgnore()
      .returning('*')
      .execute();

    const inserted = (insert.raw as NotificationDelivery[])[0];
    if (inserted !== undefined) return { claimed: true, delivery: inserted };

    const existing = await this.deliveries.findOneOrFail({ where: { dedupe_key: key } });
    if (TERMINAL_DELIVERY_STATUSES.has(existing.status)) {
      this.logger.debug(`Delivery ${key} already ${existing.status} — skipping`);
      return { claimed: false, delivery: existing };
    }
    return { claimed: true, delivery: existing };
  }

  /**
   * Record a terminal or intermediate outcome.
   *
   * `sent_at` is stamped only on SENT, and SENT means the provider ACCEPTED the
   * message — never that a device displayed it. FCM offers no delivery receipt,
   * so no code path may promote a push leg beyond this.
   */
  public async record(
    deliveryId: string,
    status: NotificationDeliveryStatus,
    details: {
      provider?: string | null;
      providerMessageId?: string | null;
      error?: string | null;
      attempt?: number;
    } = {},
  ): Promise<void> {
    const patch: QueryDeepPartialEntity<NotificationDelivery> = { status };
    if (details.provider !== undefined) patch.provider = details.provider;
    if (details.providerMessageId !== undefined) {
      patch.provider_message_id = details.providerMessageId;
    }
    patch.error_message =
      details.error === undefined || details.error === null ? null : details.error.slice(0, 1000);
    if (details.attempt !== undefined) patch.attempts = details.attempt;
    if (status === NotificationDeliveryStatus.SENT) patch.sent_at = new Date();

    await this.deliveries.update(deliveryId, patch);
  }

  /**
   * Record an outcome for a leg that was never attempted (preference off, no
   * device, provider absent). Upserts so repeated evaluation of the same
   * notification does not accumulate rows.
   */
  public async recordSkip(
    notificationId: string,
    channel: NotificationChannel,
    status: NotificationDeliveryStatus,
    provider?: string | null,
  ): Promise<void> {
    const claim = await this.claim({ notificationId, channel, provider: provider ?? null });
    if (!claim.claimed) return;
    await this.record(claim.delivery.id, status, { provider: provider ?? null });
  }

  public async findForNotification(notificationId: string): Promise<NotificationDelivery[]> {
    return await this.deliveries.find({
      where: { notification_id: notificationId },
      order: { created_at: 'ASC' },
    });
  }

  public async findOne(deliveryId: string): Promise<NotificationDelivery | null> {
    return await this.deliveries.findOne({ where: { id: deliveryId } });
  }
}
