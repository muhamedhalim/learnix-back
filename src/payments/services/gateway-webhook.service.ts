import { createHash } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EasyKashWebhookDto } from '../dto/easykash-webhook.dto';
import { GatewayWebhookEvent, PaymentStatus } from '../entities';
import { toMinorUnits } from '../money.util';
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

  public async processEasyKash(dto: EasyKashWebhookDto): Promise<GatewayWebhookResponse> {
    const providerEventId = this.providerEventId(dto);
    const existing = await this.events.findOne({
      where: { provider: 'easykash', provider_event_id: providerEventId },
    });
    if (existing?.status === 'processed') {
      return {
        status: 'already_processed',
        ...(existing.payment_id ? { payment_id: existing.payment_id } : {}),
        transaction_id: dto.easykashRef,
      };
    }
    const payment = await this.payments.getPaymentByMerchantOrderId(dto.customerReference);
    if (!payment) {
      await this.upsertEvent(dto, providerEventId, null, 'failed', 'Payment not found');
      throw new NotFoundException('Payment not found');
    }
    const event = await this.upsertEvent(dto, providerEventId, payment.id, 'processing', null);
    const status = dto.status.toUpperCase();
    let result: GatewayWebhookResponse;
    try {
      const verification = {
        amountCents: toMinorUnits(dto.Amount),
        currency: 'EGP',
        transactionId: dto.easykashRef,
      };
      if (['PAID', 'DELIVERED'].includes(status)) {
        await this.payments.processSuccessfulPayment(payment.id, verification);
        result = {
          status: 'success',
          message: 'Payment completed, access granted',
          payment_id: payment.id,
          transaction_id: dto.easykashRef,
        };
      } else if (
        status === 'REFUNDED' ||
        (status === 'CANCELED' && payment.status === PaymentStatus.COMPLETED)
      ) {
        await this.payments.processRefundedPayment(payment.id, verification);
        result = {
          status: 'refunded',
          message: 'Payment refunded',
          payment_id: payment.id,
          transaction_id: dto.easykashRef,
        };
      } else if (['NEW', 'PENDING', 'PROCESSING'].includes(status)) {
        result = {
          status: 'pending',
          message: 'Payment pending verification',
          payment_id: payment.id,
          transaction_id: dto.easykashRef,
        };
      } else if (['FAILED', 'DECLINED', 'EXPIRED', 'CANCELED'].includes(status)) {
        if (payment.status === PaymentStatus.COMPLETED) {
          result = {
            status: 'success',
            message: 'Ignored an out-of-order failure for a completed payment',
            payment_id: payment.id,
            transaction_id: dto.easykashRef,
          };
        } else {
          await this.payments.processFailedPayment(payment.id, dto.status, verification);
          result = {
            status: 'failed',
            message: dto.status,
            payment_id: payment.id,
            transaction_id: dto.easykashRef,
          };
        }
      } else {
        // Unknown provider states are held for reconciliation. Treating an
        // unfamiliar state as a decline could release discounts or close a
        // legitimate payment prematurely.
        result = {
          status: 'pending',
          message: `Unrecognized provider status: ${dto.status}`,
          payment_id: payment.id,
          transaction_id: dto.easykashRef,
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
      this.logger.error(`EasyKash webhook ${dto.easykashRef} failed: ${event.error_message}`);
      throw error;
    }
  }

  private async upsertEvent(
    dto: EasyKashWebhookDto,
    providerEventId: string,
    paymentId: string | null,
    status: string,
    error: string | null,
  ): Promise<GatewayWebhookEvent> {
    await this.events
      .createQueryBuilder()
      .insert()
      .into(GatewayWebhookEvent)
      .values({
        provider: 'easykash',
        provider_event_id: providerEventId,
        payment_id: paymentId,
        status,
        payload: {
          ProductCode: dto.ProductCode,
          Amount: dto.Amount,
          ProductType: dto.ProductType,
          PaymentMethod: dto.PaymentMethod,
          status: dto.status,
          easykashRef: dto.easykashRef,
          customerReference: dto.customerReference,
          ...(dto.Timestamp !== undefined ? { Timestamp: dto.Timestamp } : {}),
        },
        error_message: error,
        processed_at: null,
      })
      .orIgnore()
      .execute();
    const event = await this.events.findOne({
      where: { provider: 'easykash', provider_event_id: providerEventId },
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

  private providerEventId(dto: EasyKashWebhookDto): string {
    // EasyKash's reference identifies the payment, not an individual state
    // transition. Include the signed transition fields so NEW -> PAID is
    // processed while exact retries of either callback are deduplicated.
    const transition = [
      dto.easykashRef,
      dto.customerReference,
      dto.status.toUpperCase(),
      dto.Amount,
      dto.ProductCode,
      dto.ProductType,
      dto.PaymentMethod,
    ].join('\u001f');
    const digest = createHash('sha256').update(transition).digest('hex');
    return digest;
  }
}
