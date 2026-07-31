import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { AttendanceCode } from '../../attendance-codes/entities/attendance-code.entity';
import { OrderFilterDto } from '../dto';
import {
  Entitlement,
  FinancialLedgerEntry,
  GatewayWebhookEvent,
  ManualPaymentSubmission,
  ManualPaymentSubmissionStatus,
  Order,
  OrderStatus,
  Payment,
  PaymentAuditLog,
  PaymentDomainEvent,
  PaymentStatus,
  Refund,
  RefundStatus,
  Settlement,
  SettlementStatus,
} from '../entities';
import { PaymentProviderRegistry } from './payment-provider-registry.service';
import { PaymentFinalizationService } from './payment-finalization.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { SettlementsService } from './settlements.service';

@Injectable()
export class PaymentOperationsService {
  private readonly logger = new Logger(PaymentOperationsService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(PaymentDomainEvent)
    private readonly events: Repository<PaymentDomainEvent>,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly discounts: DiscountCodesService,
    private readonly settlements: SettlementsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly providers: PaymentProviderRegistry,
    private readonly finalizer: PaymentFinalizationService,
    private readonly paymentService: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  public async runMaintenance(): Promise<void> {
    await this.expireOrders();
    await this.settlements.releaseAvailableEarnings();
    await this.publishOutbox();
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  public async reconcileGatewayAttempts(): Promise<void> {
    let lastCreatedAt: Date | null = null;
    let lastId: string | null = null;
    for (;;) {
      const query = this.payments
        .createQueryBuilder('payment')
        .where('payment.status IN (:...statuses)', {
          statuses: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.EXPIRED],
        })
        .andWhere('payment.order_id IS NOT NULL')
        .andWhere('payment.provider IS NOT NULL')
        .andWhere('(payment.paymob_order_id IS NOT NULL OR payment.provider_reference IS NOT NULL)')
        .andWhere(
          "(payment.failure_reason IS NULL OR payment.failure_reason NOT LIKE 'reconciliation_quarantine:%')",
        )
        .orderBy('payment.created_at', 'ASC')
        .addOrderBy('payment.id', 'ASC')
        .take(100);
      if (lastCreatedAt !== null && lastId !== null) {
        query.andWhere(
          '(payment.created_at > :lastCreatedAt OR (payment.created_at = :lastCreatedAt AND payment.id > :lastId))',
          { lastCreatedAt, lastId },
        );
      }
      const attempts = await query.getMany();
      if (attempts.length === 0) {
        await this.reconcileStuckRefunds();
        return;
      }
      for (const payment of attempts) await this.reconcilePayment(payment);
      const last = attempts.at(-1);
      if (!last) {
        await this.reconcileStuckRefunds();
        return;
      }
      lastCreatedAt = last.created_at;
      lastId = last.id;
      if (attempts.length < 100) {
        await this.reconcileStuckRefunds();
        return;
      }
    }
  }

  private async reconcileStuckRefunds(): Promise<void> {
    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;
    for (;;) {
      const query = this.dataSource
        .getRepository(Refund)
        .createQueryBuilder('refund')
        .where('refund.status = :status', { status: RefundStatus.PROCESSING })
        .andWhere("refund.reconciliation_status IN ('pending', 'retry_scheduled')")
        .andWhere(
          '(refund.reconciliation_next_retry_at IS NULL OR refund.reconciliation_next_retry_at <= :now)',
          { now: new Date() },
        )
        .orderBy('refund.created_at', 'ASC')
        .addOrderBy('refund.id', 'ASC')
        .take(100);
      if (cursorCreatedAt && cursorId) {
        query.andWhere(
          '(refund.created_at > :cursorCreatedAt OR (refund.created_at = :cursorCreatedAt AND refund.id > :cursorId))',
          { cursorCreatedAt, cursorId },
        );
      }
      const candidates = await query.getMany();
      if (candidates.length === 0) return;
      for (const refund of candidates) await this.reconcileRefund(refund.id);
      const last = candidates.at(-1)!;
      cursorCreatedAt = last.created_at;
      cursorId = last.id;
      if (candidates.length < 100) return;
    }
  }

  private async reconcileRefund(refundId: string): Promise<void> {
    const claimed = await retryTransaction(this.dataSource, async (manager) => {
      const refund = await manager.findOne(Refund, {
        where: { id: refundId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !refund ||
        refund.status !== RefundStatus.PROCESSING ||
        refund.reconciliation_status === 'quarantined' ||
        (refund.reconciliation_lease_expires_at &&
          refund.reconciliation_lease_expires_at.getTime() > Date.now())
      ) {
        return null;
      }
      refund.reconciliation_claim_token = randomUUID();
      refund.reconciliation_lease_expires_at = new Date(Date.now() + 5 * 60_000);
      refund.reconciliation_last_attempted_at = new Date();
      refund.reconciliation_attempt_count += 1;
      refund.reconciliation_status = 'processing';
      await manager.save(refund);
      return refund;
    });
    if (!claimed) return;
    try {
      if (!claimed.payment_id) {
        await this.scheduleRefundReconciliationRetry(
          claimed,
          'Refund has no linked payment for provider reconciliation',
        );
        return;
      }
      const payment = await this.dataSource.getRepository(Payment).findOne({
        where: { id: claimed.payment_id },
      });
      if (!payment?.provider || !payment.order_id) {
        await this.scheduleRefundReconciliationRetry(
          claimed,
          'Refund payment has no reconcilable provider reference',
        );
        return;
      }
      const providerOrderReference = payment.paymob_order_id ?? payment.provider_reference;
      if (!providerOrderReference) {
        await this.scheduleRefundReconciliationRetry(
          claimed,
          'Refund payment is missing a provider order reference',
        );
        return;
      }
      const details = await this.providers
        .get(payment.provider)
        .getTransactionByOrderReference(providerOrderReference, payment.id);
      if (!details) {
        await this.scheduleRefundReconciliationRetry(
          claimed,
          'Provider did not return transaction details for the refund payment',
        );
        return;
      }
      if (
        details.providerOrderReference !== providerOrderReference ||
        details.merchantReference !== payment.id ||
        details.amountMinor !== payment.amount_minor ||
        details.currency.toUpperCase() !== payment.currency.toUpperCase() ||
        details.currency.toUpperCase() !== claimed.currency.toUpperCase()
      ) {
        await this.quarantineRefund(claimed, details);
        return;
      }
      // The product only supports whole-order refunds.  A provider-authoritative
      // transaction state of `refunded` plus a full refunded amount is therefore
      // an unambiguous refund-level fact for this exact refund.  A successful
      // original charge alone is deliberately insufficient and never releases a
      // new dispatch.
      if (
        details.status === 'refunded' &&
        details.refundedAmountMinor >= claimed.amount_minor &&
        claimed.amount_minor === payment.amount_minor
      ) {
        await this.refunds.completeProviderNotification(
          payment.id,
          `transaction:${details.transactionId}:refunded`,
          claimed.amount_minor,
          claimed.currency,
        );
        await this.finishRefundReconciliation(claimed);
        return;
      }
      await this.requireRefundReconciliationReview(
        claimed,
        details.status === 'succeeded'
          ? 'Original payment succeeded, but no provider refund fact was returned'
          : `Provider refund transaction is ${details.status}`,
      );
    } catch (error) {
      await this.scheduleRefundReconciliationRetry(
        claimed,
        error instanceof Error ? error.message : 'Unknown provider refund reconciliation error',
      );
    }
  }

  private async finishRefundReconciliation(refund: Refund): Promise<void> {
    await this.dataSource.getRepository(Refund).update(
      { id: refund.id, reconciliation_claim_token: refund.reconciliation_claim_token! },
      {
        reconciliation_status: 'reconciled',
        reconciliation_claim_token: null,
        reconciliation_lease_expires_at: null,
        reconciliation_next_retry_at: null,
        reconciliation_last_provider_error: null,
      },
    );
  }

  private async scheduleRefundReconciliationRetry(refund: Refund, error: string): Promise<void> {
    const attempts = refund.reconciliation_attempt_count;
    const nextRetryAt = new Date(
      Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7)),
    );
    await retryTransaction(this.dataSource, async (manager) => {
      const locked = await manager.findOne(Refund, {
        where: { id: refund.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.reconciliation_claim_token !== refund.reconciliation_claim_token)
        return;
      locked.reconciliation_status = 'retry_scheduled';
      locked.reconciliation_claim_token = null;
      locked.reconciliation_lease_expires_at = null;
      locked.reconciliation_next_retry_at = nextRetryAt;
      locked.reconciliation_last_provider_error = error;
      await manager.save(locked);
      if (attempts >= 3) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(PaymentDomainEvent)
          .values({
            event_name: 'refund.reconciliation_stuck',
            dedupe_key: `refund:${locked.id}:reconciliation-stuck`,
            payload: {
              refund_id: locked.id,
              payment_id: locked.payment_id,
              attempts,
              error,
              next_retry_at: nextRetryAt.toISOString(),
            },
            published_at: null,
            attempts: 0,
            last_error: null,
          } as never)
          .orIgnore()
          .execute();
      }
    });
  }

  private async requireRefundReconciliationReview(refund: Refund, reason: string): Promise<void> {
    await retryTransaction(this.dataSource, async (manager) => {
      const locked = await manager.findOne(Refund, {
        where: { id: refund.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.reconciliation_claim_token !== refund.reconciliation_claim_token)
        return;
      locked.reconciliation_status = 'reconciliation_required';
      locked.reconciliation_last_provider_error = reason;
      locked.reconciliation_claim_token = null;
      locked.reconciliation_lease_expires_at = null;
      locked.reconciliation_next_retry_at = null;
      await manager.save(locked);
      await manager
        .createQueryBuilder()
        .insert()
        .into(PaymentDomainEvent)
        .values({
          event_name: 'refund.reconciliation_required',
          dedupe_key: `refund:${locked.id}:reconciliation-required`,
          payload: { refund_id: locked.id, payment_id: locked.payment_id, reason },
          published_at: null,
          attempts: 0,
          last_error: null,
        } as never)
        .orIgnore()
        .execute();
      await manager.insert(PaymentAuditLog, {
        actor_id: null,
        action: 'refund_reconciliation_required',
        resource_type: 'refund',
        resource_id: locked.id,
        details: { reason },
        ip_address: null,
      });
    });
  }

  private async quarantineRefund(
    refund: Refund,
    details: {
      transactionId: string;
      amountMinor: number;
      currency: string;
      providerOrderReference: string;
      merchantReference: string;
    },
  ): Promise<void> {
    const reason = `reconciliation_quarantine: provider transaction ${details.transactionId} does not match refund`;
    await retryTransaction(this.dataSource, async (manager) => {
      const locked = await manager.findOne(Refund, {
        where: { id: refund.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.reconciliation_status === 'quarantined') return;
      locked.reconciliation_status = 'quarantined';
      locked.reconciliation_quarantine_reason = reason;
      locked.reconciliation_quarantined_at = new Date();
      locked.reconciliation_last_provider_error = reason;
      locked.reconciliation_claim_token = null;
      locked.reconciliation_lease_expires_at = null;
      locked.reconciliation_next_retry_at = null;
      await manager.save(locked);
      await manager.insert(PaymentAuditLog, {
        actor_id: null,
        action: 'refund_reconciliation_quarantined',
        resource_type: 'refund',
        resource_id: locked.id,
        details: {
          provider_transaction_id: details.transactionId,
          provider_amount_minor: details.amountMinor,
          provider_currency: details.currency,
          provider_order_reference: details.providerOrderReference,
          provider_merchant_reference: details.merchantReference,
        },
        ip_address: null,
      });
      await manager
        .createQueryBuilder()
        .insert()
        .into(PaymentDomainEvent)
        .values({
          event_name: 'refund.reconciliation_alert',
          dedupe_key: `refund:${locked.id}:reconciliation-quarantine`,
          payload: { refund_id: locked.id, reason },
          published_at: null,
          attempts: 0,
          last_error: null,
        } as never)
        .orIgnore()
        .execute();
    });
  }

  private async reconcilePayment(candidate: Payment): Promise<void> {
    const payment = await this.claimPaymentReconciliation(candidate.id);
    if (!payment) return;
    try {
      const provider = this.providers.get(payment.provider!);
      const providerOrderReference = payment.paymob_order_id ?? payment.provider_reference;
      if (!providerOrderReference) {
        await this.schedulePaymentReconciliationRetry(
          payment,
          'Payment is missing a provider order reference',
        );
        return;
      }
      const details = await provider.getTransactionByOrderReference(
        providerOrderReference,
        payment.id,
      );
      if (!details) {
        await this.schedulePaymentReconciliationRetry(
          payment,
          'Provider did not return transaction details',
        );
        return;
      }
      if (
        details.providerOrderReference !== providerOrderReference ||
        details.merchantReference !== payment.id ||
        details.amountMinor !== payment.amount_minor ||
        details.currency.toUpperCase() !== payment.currency.toUpperCase()
      ) {
        await this.quarantinePayment(payment, details);
        return;
      }
      const verification = {
        verifiedAmountMinor: details.amountMinor,
        verifiedCurrency: details.currency,
        verifiedOccurredAt: details.occurredAt,
      };
      if (details.status === 'succeeded') {
        if (!payment.order_id) {
          await this.schedulePaymentReconciliationRetry(
            payment,
            'Payment is missing an internal order',
          );
          return;
        }
        await this.finalizer.finalizeSuccessfulPayment({
          orderId: payment.order_id,
          paymentId: payment.id,
          sourceReference: details.transactionId,
          actorId: null,
          ...verification,
        });
        await this.finishPaymentReconciliation(payment);
        return;
      }
      if (details.status === 'refunded') {
        await this.paymentService.processSuccessfulPayment(payment.id, {
          amountCents: details.amountMinor,
          currency: details.currency,
          transactionId: details.transactionId,
          occurredAt: details.occurredAt,
        });
        await this.refunds.completeProviderNotification(
          payment.id,
          details.transactionId,
          details.amountMinor,
          details.currency,
        );
        await this.finishPaymentReconciliation(payment);
        return;
      }
      if (details.status === 'failed') {
        await this.paymentService.processFailedPayment(
          payment.id,
          'Provider reconciliation reported failure',
          {
            amountCents: details.amountMinor,
            currency: details.currency,
            transactionId: details.transactionId,
          },
        );
      }
      await this.finishPaymentReconciliation(payment);
    } catch (error) {
      await this.schedulePaymentReconciliationRetry(
        payment,
        error instanceof Error ? error.message : 'Unknown provider reconciliation error',
      );
      this.logger.error(
        `Gateway reconciliation failed for payment ${payment.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async claimPaymentReconciliation(paymentId: string): Promise<Payment | null> {
    return retryTransaction(this.dataSource, async (manager) => {
      const payment = await manager.findOne(Payment, {
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !payment ||
        payment.reconciliation_status === 'quarantined' ||
        (payment.reconciliation_next_retry_at &&
          payment.reconciliation_next_retry_at.getTime() > Date.now()) ||
        (payment.reconciliation_lease_expires_at &&
          payment.reconciliation_lease_expires_at.getTime() > Date.now())
      ) {
        return null;
      }
      payment.reconciliation_claim_token = randomUUID();
      payment.reconciliation_lease_expires_at = new Date(Date.now() + 5 * 60_000);
      payment.reconciliation_last_attempted_at = new Date();
      payment.reconciliation_attempt_count += 1;
      payment.reconciliation_status = 'processing';
      await manager.save(payment);
      return payment;
    });
  }

  private async finishPaymentReconciliation(payment: Payment): Promise<void> {
    await this.payments.update(
      { id: payment.id, reconciliation_claim_token: payment.reconciliation_claim_token! },
      {
        reconciliation_status: 'reconciled',
        reconciliation_claim_token: null,
        reconciliation_lease_expires_at: null,
        reconciliation_next_retry_at: null,
        reconciliation_last_provider_error: null,
      },
    );
  }

  private async schedulePaymentReconciliationRetry(payment: Payment, error: string): Promise<void> {
    const attempts = payment.reconciliation_attempt_count;
    const nextRetryAt = new Date(
      Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7)),
    );
    await this.payments.update(
      { id: payment.id, reconciliation_claim_token: payment.reconciliation_claim_token! },
      {
        reconciliation_status: 'retry_scheduled',
        reconciliation_claim_token: null,
        reconciliation_lease_expires_at: null,
        reconciliation_next_retry_at: nextRetryAt,
        reconciliation_last_provider_error: error,
      },
    );
    if (attempts >= 3) {
      await this.dataSource
        .createQueryBuilder()
        .insert()
        .into(PaymentDomainEvent)
        .values({
          event_name: 'payment.reconciliation_stuck',
          dedupe_key: `payment:${payment.id}:reconciliation-stuck`,
          payload: {
            payment_id: payment.id,
            attempts,
            error,
            next_retry_at: nextRetryAt.toISOString(),
          },
          published_at: null,
          attempts: 0,
          last_error: null,
        } as never)
        .orIgnore()
        .execute();
    }
  }

  private async quarantinePayment(
    payment: Payment,
    details: {
      transactionId: string;
      amountMinor: number;
      currency: string;
      providerOrderReference: string;
      merchantReference: string;
    },
  ): Promise<void> {
    const reason = `reconciliation_quarantine: provider transaction ${details.transactionId} does not match payment`;
    await retryTransaction(this.dataSource, async (manager) => {
      const locked = await manager.findOne(Payment, {
        where: { id: payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.failure_reason?.startsWith('reconciliation_quarantine:')) return;
      locked.failure_reason = reason;
      locked.reconciliation_status = 'quarantined';
      locked.reconciliation_quarantine_reason = reason;
      locked.reconciliation_quarantined_at = new Date();
      locked.reconciliation_claim_token = null;
      locked.reconciliation_lease_expires_at = null;
      locked.reconciliation_next_retry_at = null;
      await manager.save(Payment, locked);
      await manager.insert(PaymentAuditLog, {
        actor_id: null,
        action: 'payment_reconciliation_quarantined',
        resource_type: 'payment',
        resource_id: locked.id,
        details: {
          provider_transaction_id: details.transactionId,
          provider_amount_minor: details.amountMinor,
          provider_currency: details.currency,
          provider_order_reference: details.providerOrderReference,
          provider_merchant_reference: details.merchantReference,
        },
        ip_address: null,
      });
      await manager
        .createQueryBuilder()
        .insert()
        .into(PaymentDomainEvent)
        .values({
          event_name: 'payment.reconciliation_alert',
          dedupe_key: `payment:${locked.id}:reconciliation-quarantine`,
          payload: { payment_id: locked.id, reason },
          published_at: null,
          attempts: 0,
          last_error: null,
        } as never)
        .orIgnore()
        .execute();
    });
    this.logger.error(`Payment ${payment.id} quarantined during provider reconciliation`);
  }

  public async expireOrders(limit = 500): Promise<number> {
    const due = await this.orders.find({
      where: {
        status: OrderStatus.AWAITING_PAYMENT,
        expires_at: LessThan(new Date()),
      },
      order: { expires_at: 'ASC' },
      take: limit,
    });
    let expired = 0;
    for (const candidate of due) {
      await retryTransaction(this.dataSource, async (manager) => {
        const order = await manager.findOne(Order, {
          where: { id: candidate.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!order || order.status !== OrderStatus.AWAITING_PAYMENT) return;
        order.status = OrderStatus.EXPIRED;
        await manager.save(Order, order);
        if (order.payment_id) {
          await manager.update(
            Payment,
            {
              id: order.payment_id,
              status: In([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED]),
            },
            { status: PaymentStatus.EXPIRED },
          );
          await this.discounts.releaseUsageForPayment(order.payment_id, manager);
        }
        expired += 1;
      });
    }
    return expired;
  }

  public async publishOutbox(limit = 100): Promise<number> {
    const pending = await this.claimOutboxEvents(limit);
    let published = 0;
    for (const event of pending) {
      try {
        await this.eventEmitter.emitAsync(event.event_name, event.payload);
        await this.events.update(
          { id: event.id, status: 'processing', lease_token: event.lease_token! },
          {
            status: 'published',
            published_at: new Date(),
            last_error: null,
            lease_token: null,
            claimed_by: null,
            claimed_at: null,
            lease_expires_at: null,
            next_retry_at: null,
          },
        );
        published += 1;
      } catch (error) {
        await this.failOutboxEvent(
          event.id,
          event.lease_token!,
          error instanceof Error ? error.message : 'Unknown event error',
        );
      }
    }
    return published;
  }

  private async claimOutboxEvents(limit: number): Promise<PaymentDomainEvent[]> {
    const now = new Date();
    return this.dataSource.transaction(async (manager) => {
      const candidates = await manager
        .getRepository(PaymentDomainEvent)
        .createQueryBuilder('event')
        .where(
          "(event.status IN ('pending', 'failed') AND (event.next_retry_at IS NULL OR event.next_retry_at <= :now)) OR (event.status = 'processing' AND event.lease_expires_at <= :now)",
          { now },
        )
        .andWhere('event.published_at IS NULL')
        .orderBy('event.created_at', 'ASC')
        .take(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      for (const event of candidates) {
        if (event.attempts >= 8) {
          event.status = 'dead_letter';
          event.last_error = event.last_error ?? 'Maximum outbox attempts exhausted';
          event.failed_at = now;
          event.lease_token = null;
          event.claimed_by = null;
          event.lease_expires_at = null;
          event.next_retry_at = null;
          await manager.save(event);
          await this.outboxDeadLetterAlert(manager, event, event.last_error);
          continue;
        }
        event.status = 'processing';
        event.lease_token = randomUUID();
        event.claimed_by = `outbox:${process.pid}`;
        event.claimed_at = now;
        event.lease_expires_at = new Date(now.getTime() + 5 * 60_000);
        event.next_retry_at = null;
        event.attempts += 1;
        await manager.save(event);
      }
      return candidates.filter((event) => event.status === 'processing');
    });
  }

  private async failOutboxEvent(eventId: string, leaseToken: string, error: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(PaymentDomainEvent, {
        where: { id: eventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event || event.status !== 'processing' || event.lease_token !== leaseToken) return;
      const deadLetter = event.attempts >= 8;
      event.status = deadLetter ? 'dead_letter' : 'failed';
      event.last_error = error;
      event.lease_token = null;
      event.claimed_by = null;
      event.lease_expires_at = null;
      event.failed_at = deadLetter ? new Date() : null;
      event.next_retry_at = deadLetter
        ? null
        : new Date(Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(event.attempts, 7)));
      await manager.save(event);
      if (deadLetter && event.event_name !== 'payment.outbox_dead_letter') {
        await this.outboxDeadLetterAlert(manager, event, error);
      }
    });
  }

  private async outboxDeadLetterAlert(
    manager: import('typeorm').EntityManager,
    event: PaymentDomainEvent,
    error: string,
  ): Promise<void> {
    if (event.event_name === 'payment.outbox_dead_letter') return;
    await manager
      .createQueryBuilder()
      .insert()
      .into(PaymentDomainEvent)
      .values({
        event_name: 'payment.outbox_dead_letter',
        dedupe_key: `outbox:${event.id}:dead-letter`,
        payload: { outbox_event_id: event.id, event_name: event.event_name, error },
        published_at: null,
        attempts: 0,
        last_error: null,
      } as never)
      .orIgnore()
      .execute();
  }

  public async reconciliationReport(): Promise<Record<string, unknown>> {
    const [
      paidWithoutEntitlement,
      completedWithoutPaidOrder,
      activeEntitlementWithoutPaidOrder,
      ledgerImbalances,
      duplicateApprovedReferences,
      failedWebhooks,
      approvedManualWithoutPaidOrder,
      unknownCollectionOrders,
      overduePendingEarnings,
      releasedEarningsWithRefund,
      settlementOverallocations,
      settlementAllocationMismatches,
      uncoveredActiveSettlements,
      invalidPaidSettlements,
      duplicateSettlementReferences,
      duplicateSettlementKeys,
      refundConservationIssues,
      negativeAvailableBalances,
      financialOrphans,
    ] = await Promise.all([
      this.orders
        .createQueryBuilder('order')
        .where('order.status = :paid', { paid: OrderStatus.PAID })
        .andWhere('NOT EXISTS (SELECT 1 FROM entitlements e WHERE e.order_id = order.id)')
        .select(['order.id', 'order.order_number'])
        .take(100)
        .getMany(),
      this.payments
        .createQueryBuilder('payment')
        .leftJoin(Order, 'order', 'order.id = payment.order_id')
        .where('payment.status = :completed', { completed: PaymentStatus.COMPLETED })
        .andWhere('(payment.order_id IS NULL OR order.status != :paid)', { paid: OrderStatus.PAID })
        .select(['payment.id', 'payment.order_id'])
        .take(100)
        .getMany(),
      this.dataSource
        .getRepository(Entitlement)
        .createQueryBuilder('entitlement')
        .leftJoin(Order, 'order', 'order.id = entitlement.order_id')
        .where("entitlement.status = 'active'")
        .andWhere("(order.id IS NULL OR order.status != 'paid')")
        .select(['entitlement.id', 'entitlement.order_id'])
        .take(100)
        .getMany(),
      this.dataSource
        .getRepository(FinancialLedgerEntry)
        .createQueryBuilder('entry')
        .select('entry.order_id', 'order_id')
        .addSelect(
          `SUM(CASE WHEN entry.direction = 'debit' THEN entry.amount_minor ELSE -entry.amount_minor END)`,
          'imbalance_minor',
        )
        .groupBy('entry.order_id')
        .having(
          `SUM(CASE WHEN entry.direction = 'debit' THEN entry.amount_minor ELSE -entry.amount_minor END) != 0`,
        )
        .limit(100)
        .getRawMany(),
      this.dataSource
        .getRepository(ManualPaymentSubmission)
        .createQueryBuilder('submission')
        .select('submission.manual_payment_method_id', 'method_id')
        .addSelect('submission.transaction_reference', 'transaction_reference')
        .addSelect('COUNT(*)', 'count')
        .where('submission.status = :approved', {
          approved: ManualPaymentSubmissionStatus.APPROVED,
        })
        .andWhere('submission.transaction_reference IS NOT NULL')
        .groupBy('submission.manual_payment_method_id')
        .addGroupBy('submission.transaction_reference')
        .having('COUNT(*) > 1')
        .limit(100)
        .getRawMany(),
      this.dataSource.getRepository(GatewayWebhookEvent).find({
        where: { status: 'failed' },
        order: { created_at: 'DESC' },
        take: 100,
      }),
      this.dataSource
        .getRepository(ManualPaymentSubmission)
        .createQueryBuilder('submission')
        .leftJoin(Order, 'order', 'order.id = submission.order_id')
        .where('submission.status = :approved', {
          approved: ManualPaymentSubmissionStatus.APPROVED,
        })
        .andWhere("(order.id IS NULL OR order.status != 'paid')")
        .select(['submission.id', 'submission.order_id'])
        .take(100)
        .getMany(),
      this.orders
        .createQueryBuilder('order')
        .where('order.status = :paid', { paid: OrderStatus.PAID })
        .andWhere("order.collection_party = 'unknown'")
        .select(['order.id', 'order.order_number', 'order.payment_channel'])
        .take(100)
        .getMany(),
      this.dataSource.query(`
        SELECT pending.id, pending.teacher_id, pending.currency, pending.amount_minor, pending.available_at
        FROM financial_ledger_entries pending
        WHERE pending.entry_type = 'teacher_earning_pending'
          AND pending.direction = 'credit'
          AND pending.available_at <= NOW()
          AND NOT EXISTS (
            SELECT 1 FROM financial_ledger_entries released
            WHERE released.reference = 'release:' || pending.id::text || ':available'
          )
        ORDER BY pending.available_at ASC
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT pending.id, pending.order_id, pending.teacher_id
        FROM financial_ledger_entries pending
        WHERE pending.entry_type = 'teacher_earning_pending'
          AND pending.direction = 'credit'
          AND EXISTS (
            SELECT 1 FROM financial_ledger_entries released
            WHERE released.reference = 'release:' || pending.id::text || ':available'
          )
          AND EXISTS (
            SELECT 1 FROM financial_ledger_entries reversal
            WHERE reversal.order_id = pending.order_id
              AND reversal.entry_type = 'teacher_earning_reversal'
          )
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT membership.ledger_entry_id, SUM(membership.amount_minor)::text AS allocated_minor,
               MAX(earning.amount_minor)::text AS earning_minor
        FROM teacher_settlement_entries membership
        INNER JOIN teacher_settlements settlement ON settlement.id = membership.settlement_id
        INNER JOIN financial_ledger_entries earning ON earning.id = membership.ledger_entry_id
        WHERE settlement.status IN ('draft', 'approved', 'paid')
        GROUP BY membership.ledger_entry_id
        HAVING SUM(membership.amount_minor) > MAX(earning.amount_minor)
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT settlement.id, settlement.gross_amount_minor,
               COALESCE(SUM(membership.amount_minor), 0)::text AS allocated_minor
        FROM teacher_settlements settlement
        LEFT JOIN teacher_settlement_entries membership ON membership.settlement_id = settlement.id
        WHERE settlement.status IN ('draft', 'approved', 'paid')
        GROUP BY settlement.id
        HAVING COALESCE(SUM(membership.amount_minor), 0) <> settlement.gross_amount_minor
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT settlement.id, settlement.teacher_id, settlement.currency, settlement.gross_amount_minor
        FROM teacher_settlements settlement
        WHERE settlement.status IN ('draft', 'approved')
          AND settlement.gross_amount_minor > COALESCE((
            SELECT SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END)
            FROM financial_ledger_entries entry
            WHERE entry.teacher_id = settlement.teacher_id
              AND entry.currency = settlement.currency
              AND entry.account = 'teacher_payable_available'
          ), 0)
        LIMIT 100
      `),
      this.dataSource
        .getRepository(Settlement)
        .createQueryBuilder('settlement')
        .where('settlement.status = :paid', { paid: SettlementStatus.PAID })
        .andWhere(
          `(
            settlement.transfer_reference IS NULL
            OR BTRIM(settlement.transfer_reference) = ''
            OR settlement.paid_by IS NULL
            OR settlement.paid_at IS NULL
          )`,
        )
        .select([
          'settlement.id',
          'settlement.transfer_reference',
          'settlement.paid_by',
          'settlement.paid_at',
        ])
        .take(100)
        .getMany(),
      this.dataSource.query(`
        SELECT lower(btrim(transfer_reference)) AS transfer_reference, COUNT(*)::int AS count
        FROM teacher_settlements
        WHERE status = 'paid' AND transfer_reference IS NOT NULL
        GROUP BY lower(btrim(transfer_reference))
        HAVING COUNT(*) > 1
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT idempotency_key, COUNT(*)::int AS count
        FROM teacher_settlements
        GROUP BY idempotency_key
        HAVING COUNT(*) > 1
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT refund.order_id, SUM(refund.amount_minor)::text AS succeeded_refunds_minor,
               MAX("order".refunded_amount_minor)::text AS order_refunded_minor,
               MAX("order".final_amount_minor)::text AS order_final_minor
        FROM refunds refund
        INNER JOIN orders "order" ON "order".id = refund.order_id
        WHERE refund.status = 'succeeded'
        GROUP BY refund.order_id
        HAVING SUM(refund.amount_minor) > MAX("order".final_amount_minor)
            OR SUM(refund.amount_minor) <> MAX("order".refunded_amount_minor)
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT teacher_id, currency,
               SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END)::text AS balance_minor
        FROM financial_ledger_entries
        WHERE account = 'teacher_payable_available'
        GROUP BY teacher_id, currency
        HAVING SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END) < 0
        LIMIT 100
      `),
      this.dataSource.query(`
        SELECT 'financial_ledger_entries.order_id' AS relation, entry.id
        FROM financial_ledger_entries entry
        LEFT JOIN orders "order" ON "order".id = entry.order_id
        WHERE "order".id IS NULL
        UNION ALL
        SELECT 'refunds.order_id' AS relation, refund.id
        FROM refunds refund
        LEFT JOIN orders "order" ON "order".id = refund.order_id
        WHERE "order".id IS NULL
        UNION ALL
        SELECT 'teacher_settlement_entries.ledger_entry_id' AS relation, membership.id
        FROM teacher_settlement_entries membership
        LEFT JOIN financial_ledger_entries entry ON entry.id = membership.ledger_entry_id
        WHERE entry.id IS NULL
        LIMIT 100
      `),
    ]);
    return {
      generated_at: new Date().toISOString(),
      paid_orders_without_entitlement: paidWithoutEntitlement,
      completed_payments_without_paid_order: completedWithoutPaidOrder,
      active_entitlements_without_paid_order: activeEntitlementWithoutPaidOrder,
      ledger_imbalances: ledgerImbalances,
      duplicate_approved_manual_references: duplicateApprovedReferences,
      failed_gateway_webhooks: failedWebhooks,
      approved_manual_submissions_without_paid_order: approvedManualWithoutPaidOrder,
      paid_orders_with_unknown_collection_party: unknownCollectionOrders,
      overdue_pending_earnings: overduePendingEarnings,
      released_earnings_with_refund: releasedEarningsWithRefund,
      settlement_overallocations: settlementOverallocations,
      settlement_allocation_mismatches: settlementAllocationMismatches,
      active_settlements_not_covered_by_available_balance: uncoveredActiveSettlements,
      paid_settlements_missing_execution_details: invalidPaidSettlements,
      duplicate_settlement_transfer_references: duplicateSettlementReferences,
      duplicate_settlement_idempotency_keys: duplicateSettlementKeys,
      refund_conservation_issues: refundConservationIssues,
      negative_teacher_available_balances: negativeAvailableBalances,
      financial_orphans: financialOrphans,
    };
  }

  public async financialReport(filter: OrderFilterDto): Promise<Record<string, unknown>> {
    const applyFilters = (query: ReturnType<Repository<Order>['createQueryBuilder']>) => {
      // Canonical paid orders are the sole sales source. The payment join
      // excludes stale orders that were incorrectly marked paid without a
      // finalized payment, and paid_at is the financial recognition timestamp.
      query
        .innerJoin(
          Payment,
          'payment',
          'payment.id = order.payment_id AND payment.status = :completedPaymentStatus',
          { completedPaymentStatus: PaymentStatus.COMPLETED },
        )
        .where('order.status = :paidOrderStatus', { paidOrderStatus: OrderStatus.PAID })
        .andWhere('order.paid_at IS NOT NULL');
      if (filter.teacher_id)
        query.andWhere('order.teacher_id = :teacherId', { teacherId: filter.teacher_id });
      if (filter.item_type)
        query.andWhere('order.item_type = :itemType', { itemType: filter.item_type });
      if (filter.channel)
        query.andWhere('order.payment_channel = :channel', { channel: filter.channel });
      if (filter.status && filter.status !== OrderStatus.PAID) query.andWhere('1 = 0');
      if (filter.currency)
        query.andWhere('order.currency = :currency', { currency: filter.currency.toUpperCase() });
      if (filter.from) query.andWhere('order.paid_at >= :from', { from: filter.from });
      if (filter.to) query.andWhere('order.paid_at <= :to', { to: filter.to });
      return query;
    };
    const [
      byChannel,
      byTeacher,
      manualApproval,
      activationLiability,
      receivables,
      refunds,
      settlements,
    ] = await Promise.all([
      applyFilters(this.orders.createQueryBuilder('order'))
        .select('order.payment_channel', 'channel')
        .addSelect('order.currency', 'currency')
        .addSelect('COUNT(*)', 'orders')
        .addSelect('SUM(order.final_amount_minor)', 'gross_minor')
        .addSelect('SUM(order.platform_commission_minor)', 'platform_commission_minor')
        .addSelect('SUM(order.teacher_earning_minor)', 'teacher_earning_minor')
        .groupBy('order.payment_channel')
        .addGroupBy('order.currency')
        .getRawMany(),
      applyFilters(this.orders.createQueryBuilder('order'))
        .select('order.teacher_id', 'teacher_id')
        .addSelect('order.currency', 'currency')
        .addSelect('COUNT(*)', 'orders')
        .addSelect('SUM(order.final_amount_minor)', 'gross_minor')
        .addSelect('SUM(order.teacher_earning_minor)', 'teacher_earning_minor')
        .groupBy('order.teacher_id')
        .addGroupBy('order.currency')
        .limit(500)
        .getRawMany(),
      this.dataSource
        .getRepository(ManualPaymentSubmission)
        .createQueryBuilder('submission')
        .select('submission.currency', 'currency')
        .addSelect('COUNT(*)', 'submissions')
        .addSelect(
          'AVG(EXTRACT(EPOCH FROM (submission.reviewed_at - submission.submitted_at)))',
          'average_review_seconds',
        )
        .where('submission.reviewed_at IS NOT NULL')
        .groupBy('submission.currency')
        .getRawMany(),
      this.dataSource
        .getRepository(AttendanceCode)
        .createQueryBuilder('code')
        .select('code.collection_party', 'collection_party')
        .addSelect('code.currency', 'currency')
        .addSelect('COUNT(*)', 'unused_codes')
        .addSelect('COALESCE(SUM(code.face_value_minor), 0)', 'unused_liability_minor')
        .where('code.is_used = false')
        .andWhere('code.is_active = true')
        .andWhere('code.expires_at > NOW()')
        .groupBy('code.collection_party')
        .addGroupBy('code.currency')
        .getRawMany(),
      this.dataSource
        .getRepository(FinancialLedgerEntry)
        .createQueryBuilder('entry')
        .select('entry.teacher_id', 'teacher_id')
        .addSelect('entry.currency', 'currency')
        .addSelect(
          `SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END)`,
          'outstanding_minor',
        )
        .where("entry.account = 'platform_receivable'")
        .groupBy('entry.teacher_id')
        .addGroupBy('entry.currency')
        .having(
          `SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END) != 0`,
        )
        .limit(500)
        .getRawMany(),
      this.dataSource.getRepository(Refund).find({
        order: { created_at: 'DESC' },
        take: 100,
      }),
      this.dataSource.getRepository(Settlement).find({
        order: { created_at: 'DESC' },
        take: 100,
      }),
    ]);
    return {
      generated_at: new Date().toISOString(),
      filters: filter,
      sales_by_channel: byChannel,
      sales_by_teacher: byTeacher,
      manual_payment_approval_times: manualApproval,
      activation_code_unused_liability: activationLiability,
      outstanding_platform_receivables: receivables,
      recent_refunds: refunds,
      recent_settlements: settlements,
    };
  }
}
