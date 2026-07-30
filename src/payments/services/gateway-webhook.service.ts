import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';

import { GatewayWebhookEvent, Payment, PaymentDomainEvent } from '../entities';
import type { ProviderWebhookEvent } from '../providers/payment-gateway.interface';
import { PaymentsService } from './payments.service';

export interface GatewayWebhookResponse {
  status: 'success' | 'pending' | 'failed' | 'refunded' | 'error' | 'already_processed';
  message?: string;
  payment_id?: string;
  transaction_id?: string;
}

const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;
const WEBHOOK_RETRY_BASE_MS = 30_000;

/**
 * Claims a provider event before applying financial side effects.  The unique
 * provider/event constraint is the durable replay key; `processing` is a
 * recoverable lease, not a terminal acknowledgement.  A crash therefore
 * causes a later provider retry (or reconciliation) to resume the same event.
 */
@Injectable()
export class GatewayWebhookService {
  private readonly logger = new Logger(GatewayWebhookService.name);
  private readonly workerId = `webhook:${process.pid}:${randomUUID()}`;

  constructor(
    @InjectRepository(GatewayWebhookEvent)
    private readonly events: Repository<GatewayWebhookEvent>,
    private readonly dataSource: DataSource,
    private readonly payments: PaymentsService,
  ) {}

  public async process(webhook: ProviderWebhookEvent): Promise<GatewayWebhookResponse> {
    const payment = await this.payments.getPaymentByMerchantOrderId(webhook.merchantReference);
    if (!payment) {
      await this.recordRejectedEvent(webhook, 'Payment not found');
      throw new NotFoundException('Payment not found');
    }
    this.assertWebhookMatchesPayment(webhook, payment);

    const event = await this.claimEvent(webhook, payment.id);
    if (event === null) {
      return {
        status: 'pending',
        message: 'Webhook event is already being processed',
        payment_id: payment.id,
        transaction_id: webhook.transactionId,
      };
    }
    if (event.status === 'processed') {
      return {
        status: 'already_processed',
        payment_id: event.payment_id ?? payment.id,
        transaction_id: webhook.transactionId,
      };
    }

    try {
      const verification = {
        amountCents: webhook.amountMinor,
        currency: webhook.currency,
        transactionId: webhook.transactionId,
        ...(webhook.occurredAt === undefined ? {} : { occurredAt: webhook.occurredAt }),
      };
      let result: GatewayWebhookResponse;
      if (webhook.outcome === 'succeeded') {
        await this.payments.processSuccessfulPayment(payment.id, verification);
        result = this.result('success', 'Payment completed, access granted', payment.id, webhook);
      } else if (webhook.outcome === 'refunded') {
        // A provider refund is authoritative.  If its success callback was
        // delayed/lost, first run the one canonical paid finalizer and then the
        // one canonical refund finalizer.  Both use order/payment row locks and
        // idempotent ledger/entitlement writes.
        await this.payments.processSuccessfulPayment(payment.id, verification);
        await this.payments.processRefundedPayment(payment.id, verification);
        result = this.result('refunded', 'Payment refunded', payment.id, webhook);
      } else if (webhook.outcome === 'pending') {
        result = this.result('pending', 'Payment pending verification', payment.id, webhook);
      } else {
        await this.payments.processFailedPayment(
          payment.id,
          webhook.message ?? 'Payment declined',
          verification,
        );
        result = this.result('failed', webhook.message ?? 'Payment declined', payment.id, webhook);
      }

      await this.completeEvent(event.id, event.lease_token!);
      return result;
    } catch (error) {
      await this.failEvent(
        event.id,
        event.lease_token!,
        error instanceof Error ? error.message : 'Unknown webhook error',
      );
      this.logger.error(`Gateway webhook transaction ${webhook.transactionId} failed`);
      throw error;
    }
  }

  /**
   * Recovery is independent of a fresh delivery from the provider.  It uses
   * SKIP LOCKED so several replicas can scan the same table safely. Financial
   * effects remain effectively-once through the locked payment finalizers.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  public async recoverStaleEvents(limit = 50): Promise<number> {
    const now = new Date();
    const eventIds = await this.dataSource.transaction(async (manager) => {
      const candidates = await manager
        .createQueryBuilder(GatewayWebhookEvent, 'event')
        .where(
          "(event.status = 'processing' AND event.lease_expires_at <= :now) OR (event.status = 'failed' AND event.next_retry_at <= :now)",
          { now },
        )
        .andWhere('event.attempt_count < event.max_attempts')
        .orderBy('event.created_at', 'ASC')
        .take(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      for (const event of candidates) {
        event.status = 'received';
        event.lease_token = null;
        event.claimed_by = null;
        event.claimed_at = null;
        event.lease_expires_at = null;
        event.heartbeat_at = null;
        event.next_retry_at = null;
        await manager.save(event);
      }
      return candidates.map((event) => event.id);
    });
    for (const id of eventIds) {
      const event = await this.events.findOne({ where: { id } });
      if (!event) continue;
      const webhook = this.recoverableWebhook(event);
      if (!webhook) {
        await this.failEvent(id, null, 'Webhook recovery payload is incomplete');
        continue;
      }
      try {
        await this.process(webhook);
      } catch {
        // failEvent records retry state and escalation. The next cron pass owns recovery.
      }
    }
    return eventIds.length;
  }

  public async heartbeat(eventId: string, leaseToken: string): Promise<boolean> {
    const now = new Date();
    const result = await this.events.update(
      { id: eventId, status: 'processing', lease_token: leaseToken },
      {
        heartbeat_at: now,
        lease_expires_at: new Date(now.getTime() + WEBHOOK_PROCESSING_LEASE_MS),
      },
    );
    return result.affected === 1;
  }

  private result(
    status: GatewayWebhookResponse['status'],
    message: string,
    paymentId: string,
    webhook: ProviderWebhookEvent,
  ): GatewayWebhookResponse {
    return { status, message, payment_id: paymentId, transaction_id: webhook.transactionId };
  }

  private assertWebhookMatchesPayment(webhook: ProviderWebhookEvent, payment: Payment): void {
    const expectedAmount = payment.amount_minor ?? Math.round(Number(payment.final_amount) * 100);
    if (webhook.amountMinor !== expectedAmount) {
      throw new BadRequestException('Webhook amount does not match payment amount');
    }
    if (webhook.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      throw new BadRequestException('Webhook currency does not match payment currency');
    }
    if (payment.provider !== webhook.provider) {
      throw new BadRequestException('Webhook provider does not match payment provider');
    }
    const checkoutOrderReference = payment.paymob_order_id ?? payment.provider_reference;
    if (
      checkoutOrderReference !== null &&
      checkoutOrderReference !== webhook.providerOrderReference
    ) {
      throw new BadRequestException('Webhook order does not match payment order');
    }
    if (webhook.transactionId === '') {
      throw new BadRequestException('Webhook transaction reference is missing');
    }
  }

  private async claimEvent(
    webhook: ProviderWebhookEvent,
    paymentId: string,
  ): Promise<GatewayWebhookEvent | null> {
    return this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into(GatewayWebhookEvent)
        .values({
          provider: webhook.provider,
          provider_event_id: webhook.providerEventId,
          payment_id: paymentId,
          status: 'received',
          payload: this.persistedPayload(webhook) as never,
          error_message: null,
          processed_at: null,
          lease_token: null,
          claimed_by: null,
          claimed_at: null,
          lease_expires_at: null,
          heartbeat_at: null,
          next_retry_at: null,
          attempt_count: 0,
          max_attempts: 8,
          last_error: null,
        })
        .orIgnore()
        .execute();
      const event = await manager.findOne(GatewayWebhookEvent, {
        where: { provider: webhook.provider, provider_event_id: webhook.providerEventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) throw new Error('Failed to persist gateway webhook event');
      if (event.status === 'processed') return event;
      if (event.status === 'dead_letter') {
        throw new BadRequestException(
          'Webhook event is in dead-letter state and requires a reviewed replay',
        );
      }
      if (
        event.status === 'processing' &&
        event.lease_expires_at !== null &&
        event.lease_expires_at.getTime() > Date.now()
      ) {
        return null;
      }
      if (
        event.status === 'failed' &&
        event.next_retry_at !== null &&
        event.next_retry_at.getTime() > Date.now()
      ) {
        return null;
      }
      if (event.attempt_count >= event.max_attempts) {
        event.status = 'dead_letter';
        event.last_error = event.last_error ?? 'Maximum webhook attempts exhausted';
        event.error_message = event.last_error;
        await manager.save(event);
        throw new BadRequestException(
          'Webhook event is in dead-letter state and requires a reviewed replay',
        );
      }
      const now = new Date();
      event.payment_id = paymentId;
      event.status = 'processing';
      event.error_message = null;
      event.last_error = null;
      event.payload = this.persistedPayload(webhook) as never;
      event.lease_token = randomUUID();
      event.claimed_by = this.workerId;
      event.claimed_at = now;
      event.heartbeat_at = now;
      event.lease_expires_at = new Date(now.getTime() + WEBHOOK_PROCESSING_LEASE_MS);
      event.next_retry_at = null;
      event.attempt_count += 1;
      await manager.save(event);
      return event;
    });
  }

  private async completeEvent(eventId: string, leaseToken: string): Promise<void> {
    await this.events.update(
      { id: eventId, status: 'processing', lease_token: leaseToken },
      {
        status: 'processed',
        processed_at: new Date(),
        error_message: null,
        last_error: null,
        lease_token: null,
        claimed_by: null,
        lease_expires_at: null,
        heartbeat_at: null,
        next_retry_at: null,
      },
    );
  }

  private async failEvent(
    eventId: string,
    leaseToken: string | null,
    message: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(GatewayWebhookEvent, {
        where: { id: eventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event || event.status === 'processed') return;
      if (leaseToken !== null && event.lease_token !== leaseToken) return;
      const deadLetter = event.attempt_count >= event.max_attempts;
      event.status = deadLetter ? 'dead_letter' : 'failed';
      event.error_message = message;
      event.last_error = message;
      event.lease_token = null;
      event.claimed_by = null;
      event.lease_expires_at = null;
      event.heartbeat_at = null;
      event.next_retry_at = deadLetter
        ? null
        : new Date(Date.now() + WEBHOOK_RETRY_BASE_MS * 2 ** Math.min(event.attempt_count, 6));
      await manager.save(event);
      if (deadLetter) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(PaymentDomainEvent)
          .values({
            event_name: 'payment.webhook_dead_letter',
            dedupe_key: `webhook:${event.id}:dead-letter`,
            payload: { webhook_event_id: event.id, payment_id: event.payment_id, error: message },
            published_at: null,
            attempts: 0,
            last_error: null,
          } as never)
          .orIgnore()
          .execute();
      }
    });
  }

  private async recordRejectedEvent(webhook: ProviderWebhookEvent, message: string): Promise<void> {
    await this.events
      .createQueryBuilder()
      .insert()
      .into(GatewayWebhookEvent)
      .values({
        provider: webhook.provider,
        provider_event_id: webhook.providerEventId,
        payment_id: null,
        status: 'failed',
        payload: webhook.payload as never,
        error_message: message,
        processed_at: null,
        lease_token: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        heartbeat_at: null,
        next_retry_at: null,
        attempt_count: 1,
        max_attempts: 8,
        last_error: message,
      })
      .orIgnore()
      .execute();
  }

  private persistedPayload(webhook: ProviderWebhookEvent): Record<string, unknown> {
    return {
      ...webhook.payload,
      __payment_recovery: {
        provider: webhook.provider,
        providerEventId: webhook.providerEventId,
        merchantReference: webhook.merchantReference,
        providerOrderReference: webhook.providerOrderReference,
        transactionId: webhook.transactionId,
        amountMinor: webhook.amountMinor,
        currency: webhook.currency,
        occurredAt: webhook.occurredAt?.toISOString() ?? null,
        outcome: webhook.outcome,
        message: webhook.message ?? null,
      },
    };
  }

  private recoverableWebhook(event: GatewayWebhookEvent): ProviderWebhookEvent | null {
    const facts = event.payload['__payment_recovery'];
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null;
    const value = facts as Record<string, unknown>;
    if (
      typeof value['provider'] !== 'string' ||
      typeof value['providerEventId'] !== 'string' ||
      typeof value['merchantReference'] !== 'string' ||
      typeof value['providerOrderReference'] !== 'string' ||
      typeof value['transactionId'] !== 'string' ||
      typeof value['amountMinor'] !== 'number' ||
      typeof value['currency'] !== 'string' ||
      !['pending', 'succeeded', 'failed', 'refunded'].includes(String(value['outcome']))
    ) {
      return null;
    }
    const occurredAt =
      typeof value['occurredAt'] === 'string' && Number.isFinite(Date.parse(value['occurredAt']))
        ? new Date(value['occurredAt'])
        : undefined;
    return {
      provider: value['provider'],
      providerEventId: value['providerEventId'],
      merchantReference: value['merchantReference'],
      providerOrderReference: value['providerOrderReference'],
      transactionId: value['transactionId'],
      amountMinor: value['amountMinor'],
      currency: value['currency'],
      ...(occurredAt ? { occurredAt } : {}),
      outcome: value['outcome'] as ProviderWebhookEvent['outcome'],
      ...(typeof value['message'] === 'string' ? { message: value['message'] } : {}),
      payload: event.payload,
    };
  }
}
