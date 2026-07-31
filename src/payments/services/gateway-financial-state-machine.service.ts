import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  GatewayWebhookEvent,
  Order,
  PaymentAuditLog,
  PaymentDomainEvent,
  Payment,
  PaymentChannel,
  Refund,
  RefundStatus,
} from '../entities';
import type { ProviderWebhookEvent } from '../providers/payment-gateway.interface';
import { PaymentFinalizationService } from './payment-finalization.service';
import { RefundsService } from './refunds.service';

/**
 * The one transaction boundary for successful and refunded provider events.
 * Locks are always acquired event -> payment -> order -> refund (the refund
 * service receives this manager and therefore cannot create a second commit).
 */
@Injectable()
export class GatewayFinancialStateMachineService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly finalizer: PaymentFinalizationService,
    private readonly refunds: RefundsService,
  ) {}

  public async apply(
    eventId: string,
    leaseToken: string,
    paymentId: string,
    webhook: ProviderWebhookEvent,
  ): Promise<'completed' | 'reconciliation_required'> {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(GatewayWebhookEvent, {
        where: { id: eventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event || event.status === 'processed') return 'completed';
      if (event.status !== 'processing' || event.lease_token !== leaseToken) {
        throw new NotFoundException('Webhook processing lease was lost');
      }
      const payment = await manager.findOne(Payment, {
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment?.order_id) throw new NotFoundException('Payment not found');
      const order = await manager.findOne(Order, {
        where: { id: payment.order_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('Order not found');
      const input = {
        orderId: payment.order_id,
        paymentId: payment.id,
        sourceReference: webhook.transactionId,
        actorId: null,
        verifiedAmountMinor: webhook.amountMinor,
        verifiedCurrency: webhook.currency,
        ...(webhook.occurredAt === undefined ? {} : { verifiedOccurredAt: webhook.occurredAt }),
      };
      // A provider-refunded transaction is a final fact. Finalize and reverse
      // in the same transaction so a crash cannot leave an active entitlement.
      if (webhook.outcome === 'succeeded' || webhook.outcome === 'refunded') {
        try {
          await this.finalizer.finalizeSuccessfulPayment(input, manager);
        } catch (error) {
          if (
            error instanceof UnprocessableEntityException ||
            error instanceof NotFoundException
          ) {
            await this.recordFulfillmentCompensation(
              manager,
              payment,
              order,
              webhook,
              error.message,
            );
            // The event is deliberately not completed: GatewayWebhookService
            // moves it to failed/retry after this transaction commits.
            return 'reconciliation_required';
          }
          throw error;
        }
      }
      if (webhook.outcome === 'refunded') {
        await this.refunds.completeProviderNotificationInTransaction(
          manager,
          payment.id,
          webhook.transactionId,
          webhook.amountMinor,
          webhook.currency,
        );
      }
      if (webhook.outcome === 'succeeded' || webhook.outcome === 'refunded') {
        event.status = 'processed';
        event.processed_at = new Date();
        event.error_message = null;
        event.last_error = null;
        event.lease_token = null;
        event.claimed_by = null;
        event.lease_expires_at = null;
        event.heartbeat_at = null;
        event.next_retry_at = null;
        await manager.save(event);
      }
      return 'completed';
    });
  }

  private async recordFulfillmentCompensation(
    manager: import('typeorm').EntityManager,
    payment: Payment,
    order: Order,
    webhook: ProviderWebhookEvent,
    reason: string,
  ): Promise<void> {
    const existing = await manager
      .createQueryBuilder(Refund, 'refund')
      .where('refund.order_id = :orderId', { orderId: order.id })
      .andWhere("refund.status IN ('requested', 'approved', 'processing')")
      .setLock('pessimistic_write')
      .getOne();
    if (!existing) {
      await manager.save(
        Refund,
        manager.create(Refund, {
          order_id: order.id,
          payment_id: payment.id,
          channel: PaymentChannel.GATEWAY,
          amount_minor: webhook.amountMinor,
          currency: webhook.currency.toUpperCase(),
          status: RefundStatus.REQUESTED,
          reason_code: 'fulfillment_compensation',
          reason: 'Verified provider capture could not be fulfilled',
          internal_note: reason,
          external_method: payment.provider,
          external_reference: null,
          proof_file_key: null,
          requested_by: order.student_id,
          approved_by: null,
          completed_by: null,
          completed_at: null,
          metadata: {
            compensation_required: true,
            provider_transaction_id: webhook.transactionId,
          },
        }),
      );
    }
    payment.reconciliation_status = 'reconciliation_required';
    payment.reconciliation_last_provider_error = reason;
    payment.reconciliation_next_retry_at = null;
    payment.failure_reason = `reconciliation_required: fulfillment failed: ${reason}`;
    await manager.save(Payment, payment);
    await manager.insert(PaymentAuditLog, {
      actor_id: null,
      action: 'payment_fulfillment_compensation_required',
      resource_type: 'payment',
      resource_id: payment.id,
      details: {
        order_id: order.id,
        provider_transaction_id: webhook.transactionId,
        amount_minor: webhook.amountMinor,
        currency: webhook.currency,
        reason,
      },
      ip_address: null,
    });
    await manager
      .createQueryBuilder()
      .insert()
      .into(PaymentDomainEvent)
      .values({
        event_name: 'payment.fulfillment_compensation_required',
        dedupe_key: `payment:${payment.id}:fulfillment-compensation`,
        payload: {
          payment_id: payment.id,
          order_id: order.id,
          provider_transaction_id: webhook.transactionId,
          reason,
        },
        published_at: null,
        attempts: 0,
        last_error: null,
      } as never)
      .orIgnore()
      .execute();
  }
}
