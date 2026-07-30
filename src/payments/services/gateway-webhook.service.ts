import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GatewayWebhookEvent, Payment, PaymentStatus } from '../entities';
import type { ProviderWebhookEvent } from '../providers/payment-gateway.interface';
import { PaymentsService } from './payments.service';

export interface GatewayWebhookResponse {
  status: 'success' | 'pending' | 'failed' | 'refunded' | 'error' | 'already_processed';
  message?: string;
  payment_id?: string;
  transaction_id?: string;
}

@Injectable()
export class GatewayWebhookService {
  private readonly logger = new Logger(GatewayWebhookService.name);

  constructor(
    @InjectRepository(GatewayWebhookEvent)
    private readonly events: Repository<GatewayWebhookEvent>,
    private readonly payments: PaymentsService,
  ) {}

  public async process(webhook: ProviderWebhookEvent): Promise<GatewayWebhookResponse> {
    const existing = await this.events.findOne({
      where: {
        provider: webhook.provider,
        provider_event_id: webhook.providerEventId,
      },
    });
    if (existing?.status === 'processed') {
      return {
        status: 'already_processed',
        ...(existing.payment_id ? { payment_id: existing.payment_id } : {}),
        transaction_id: webhook.transactionId,
      };
    }

    const payment = await this.payments.getPaymentByMerchantOrderId(webhook.merchantReference);
    if (!payment) {
      await this.upsertEvent(webhook, null, 'failed', 'Payment not found');
      throw new NotFoundException('Payment not found');
    }
    this.assertWebhookMatchesPayment(webhook, payment);

    const event = await this.upsertEvent(webhook, payment.id, 'processing', null);
    let result: GatewayWebhookResponse;
    try {
      const verification = {
        amountCents: webhook.amountMinor,
        currency: webhook.currency,
        transactionId: webhook.transactionId,
      };
      if (webhook.outcome === 'succeeded') {
        await this.payments.processSuccessfulPayment(payment.id, verification);
        result = {
          status: 'success',
          message: 'Payment completed, access granted',
          payment_id: payment.id,
          transaction_id: webhook.transactionId,
        };
      } else if (webhook.outcome === 'refunded') {
        if (payment.status === PaymentStatus.COMPLETED) {
          await this.payments.processRefundedPayment(payment.id, verification);
          result = {
            status: 'refunded',
            message: 'Payment refunded',
            payment_id: payment.id,
            transaction_id: webhook.transactionId,
          };
        } else {
          await this.payments.processFailedPayment(
            payment.id,
            webhook.message ?? 'Payment voided',
            verification,
          );
          result = {
            status: 'failed',
            message: webhook.message ?? 'Payment voided',
            payment_id: payment.id,
            transaction_id: webhook.transactionId,
          };
        }
      } else if (webhook.outcome === 'pending') {
        result = {
          status: 'pending',
          message: 'Payment pending verification',
          payment_id: payment.id,
          transaction_id: webhook.transactionId,
        };
      } else if (payment.status === PaymentStatus.COMPLETED) {
        result = {
          status: 'success',
          message: 'Ignored an out-of-order failure for a completed payment',
          payment_id: payment.id,
          transaction_id: webhook.transactionId,
        };
      } else {
        await this.payments.processFailedPayment(
          payment.id,
          webhook.message ?? 'Payment declined',
          verification,
        );
        result = {
          status: 'failed',
          message: webhook.message ?? 'Payment declined',
          payment_id: payment.id,
          transaction_id: webhook.transactionId,
        };
      }

      event.status = 'processed';
      event.processed_at = new Date();
      event.error_message = null;
      await this.events.save(event);
      return result;
    } catch (error) {
      event.status = 'failed';
      event.error_message = error instanceof Error ? error.message : 'Unknown webhook error';
      await this.events.save(event);
      this.logger.error(
        `Gateway webhook transaction ${webhook.transactionId} failed: ${event.error_message}`,
      );
      throw error;
    }
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

    // The existing schema retains the original checkout-order reference in the
    // legacy-named column after finalization replaces provider_reference with
    // the transaction reference used by refunds and ledger reconciliation.
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

  private async upsertEvent(
    webhook: ProviderWebhookEvent,
    paymentId: string | null,
    status: string,
    error: string | null,
  ): Promise<GatewayWebhookEvent> {
    await this.events
      .createQueryBuilder()
      .insert()
      .into(GatewayWebhookEvent)
      .values({
        provider: webhook.provider,
        provider_event_id: webhook.providerEventId,
        payment_id: paymentId,
        status,
        payload: webhook.payload as never,
        error_message: error,
        processed_at: null,
      })
      .orIgnore()
      .execute();
    const event = await this.events.findOne({
      where: {
        provider: webhook.provider,
        provider_event_id: webhook.providerEventId,
      },
    });
    if (!event) throw new Error('Failed to persist gateway webhook event');
    if (event.status !== 'processed') {
      event.payment_id = paymentId ?? event.payment_id;
      event.status = status;
      event.error_message = error;
      await this.events.save(event);
    }
    return event;
  }
}
