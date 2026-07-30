import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, Repository } from 'typeorm';

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
    const candidates = await this.dataSource.getRepository(Refund).find({
      where: { status: RefundStatus.PROCESSING },
      order: { created_at: 'ASC' },
      take: 100,
    });
    for (const refund of candidates) {
      try {
        if (!refund.payment_id) continue;
        const payment = await this.payments.findOne({ where: { id: refund.payment_id } });
        if (!payment?.provider || !payment.order_id) continue;
        const providerOrderReference = payment.paymob_order_id ?? payment.provider_reference;
        if (!providerOrderReference) continue;
        const details = await this.providers
          .get(payment.provider)
          .getTransactionByOrderReference(providerOrderReference, payment.id);
        if (!details) continue;
        if (
          details.providerOrderReference !== providerOrderReference ||
          details.merchantReference !== payment.id ||
          details.amountMinor !== refund.amount_minor ||
          details.currency.toUpperCase() !== refund.currency.toUpperCase()
        ) {
          await this.quarantinePayment(payment, details);
          continue;
        }
        if (details.status === 'refunded') {
          await this.refunds.completeProviderNotification(
            payment.id,
            details.transactionId,
            details.amountMinor,
            details.currency,
          );
        } else if (refund.updated_at.getTime() < Date.now() - 15 * 60_000) {
          this.logger.error(
            `Gateway refund ${refund.id} is still processing after fifteen minutes`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Gateway refund reconciliation failed for ${refund.id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private async reconcilePayment(payment: Payment): Promise<void> {
    try {
      const provider = this.providers.get(payment.provider!);
      const providerOrderReference = payment.paymob_order_id ?? payment.provider_reference;
      if (!providerOrderReference) return;
      const details = await provider.getTransactionByOrderReference(
        providerOrderReference,
        payment.id,
      );
      if (!details) return;
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
        if (!payment.order_id) return;
        await this.finalizer.finalizeSuccessfulPayment({
          orderId: payment.order_id,
          paymentId: payment.id,
          sourceReference: details.transactionId,
          actorId: null,
          ...verification,
        });
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
    } catch (error) {
      this.logger.error(
        `Gateway reconciliation failed for payment ${payment.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
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
    const pending = await this.events.find({
      where: { published_at: IsNull() },
      order: { created_at: 'ASC' },
      take: limit,
    });
    let published = 0;
    for (const event of pending) {
      try {
        this.eventEmitter.emit(event.event_name, event.payload);
        await this.events.update(
          { id: event.id, published_at: IsNull() },
          { published_at: new Date(), attempts: event.attempts + 1, last_error: null },
        );
        published += 1;
      } catch (error) {
        await this.events.update(event.id, {
          attempts: event.attempts + 1,
          last_error: error instanceof Error ? error.message : 'Unknown event error',
        });
      }
    }
    return published;
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
    };
  }

  public async financialReport(filter: OrderFilterDto): Promise<Record<string, unknown>> {
    const applyFilters = (query: ReturnType<Repository<Order>['createQueryBuilder']>) => {
      query.where('1 = 1');
      if (filter.teacher_id)
        query.andWhere('order.teacher_id = :teacherId', { teacherId: filter.teacher_id });
      if (filter.item_type)
        query.andWhere('order.item_type = :itemType', { itemType: filter.item_type });
      if (filter.channel)
        query.andWhere('order.payment_channel = :channel', { channel: filter.channel });
      if (filter.status) query.andWhere('order.status = :status', { status: filter.status });
      if (filter.currency)
        query.andWhere('order.currency = :currency', { currency: filter.currency.toUpperCase() });
      if (filter.from) query.andWhere('order.created_at >= :from', { from: filter.from });
      if (filter.to) query.andWhere('order.created_at <= :to', { to: filter.to });
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
