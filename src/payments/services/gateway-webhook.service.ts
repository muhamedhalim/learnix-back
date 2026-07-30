import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { GatewayWebhookEvent, Payment } from '../entities';
import type { ProviderWebhookEvent } from '../providers/payment-gateway.interface';
import { PaymentsService } from './payments.service';

export interface GatewayWebhookResponse {
  status: 'success' | 'pending' | 'failed' | 'refunded' | 'error' | 'already_processed';
  message?: string;
  payment_id?: string;
  transaction_id?: string;
}

const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;

/**
 * Claims a provider event before applying financial side effects.  The unique
 * provider/event constraint is the durable replay key; `processing` is a
 * recoverable lease, not a terminal acknowledgement.  A crash therefore
 * causes a later provider retry (or reconciliation) to resume the same event.
 */
@Injectable()
export class GatewayWebhookService {
  private readonly logger = new Logger(GatewayWebhookService.name);

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

      await this.completeEvent(event.id);
      return result;
    } catch (error) {
      await this.failEvent(
        event.id,
        error instanceof Error ? error.message : 'Unknown webhook error',
      );
      this.logger.error(`Gateway webhook transaction ${webhook.transactionId} failed`);
      throw error;
    }
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
          payload: webhook.payload as never,
          error_message: null,
          processed_at: null,
        })
        .orIgnore()
        .execute();
      const event = await manager.findOne(GatewayWebhookEvent, {
        where: { provider: webhook.provider, provider_event_id: webhook.providerEventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) throw new Error('Failed to persist gateway webhook event');
      if (event.status === 'processed') return event;
      if (
        event.status === 'processing' &&
        event.updated_at.getTime() > Date.now() - WEBHOOK_PROCESSING_LEASE_MS
      ) {
        return null;
      }
      event.payment_id = paymentId;
      event.status = 'processing';
      event.error_message = null;
      event.payload = webhook.payload as never;
      await manager.save(event);
      return event;
    });
  }

  private async completeEvent(eventId: string): Promise<void> {
    await this.events.update(
      { id: eventId, status: 'processing' },
      { status: 'processed', processed_at: new Date(), error_message: null },
    );
  }

  private async failEvent(eventId: string, message: string): Promise<void> {
    await this.events.update(
      { id: eventId, status: 'processing' },
      { status: 'failed', error_message: message },
    );
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
      })
      .orIgnore()
      .execute();
  }
}
