import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityManager } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { PaymentAuditLog } from '../../payments/entities/payment-audit-log.entity';
import { Payment } from '../../payments/entities/payment.entity';
import { MarketplaceEnrollmentStatus, MarketplaceLedgerDirection, MarketplaceLedgerEntryType, MarketplaceOrderStatus } from '../common/enums';
import { EarningsService } from '../earnings/earnings.service';
import { LedgerService } from '../earnings/ledger.service';
import { MarketplaceEarningCreatedEvent, MarketplaceEnrollmentGrantedEvent, MarketplaceOrderFailedEvent, MarketplaceOrderPaidEvent, MarketplacePaymentDiscrepancyEvent } from '../events/domain.events';
import { MarketplaceEnrollment, MarketplaceOrder } from './entities';

export type SettlementOutcome = 'settled' | 'already_settled' | 'discrepancy';
export type FailureOutcome = 'failed' | 'ignored';

/**
 * FR-099, FR-102, FR-104. The one place a paid `MarketplaceOrder` becomes
 * access: enrollment + earning + the `course_sale`/`platform_commission`
 * ledger pair, written together through the SAME `manager` the caller
 * passed (`GatewayFinancialStateMachineService.apply()`'s marketplace
 * branch, or the standalone `MarketplaceWebhookController`'s own
 * transaction) — a forced failure at any step rolls every prior write in
 * this method back too, since nothing here opens its own transaction.
 * Amounts always come from the order's own snapshot, never the webhook
 * payload beyond the one comparison FR-104 requires.
 */
@Injectable()
export class MarketplaceSettlementService {
  private readonly logger = new Logger(MarketplaceSettlementService.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly earnings: EarningsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * `verifiedAmountMinor`/`verifiedCurrency` are the gateway's own
   * confirmed capture (never a client-supplied value). `manager` MUST be
   * the transaction the caller is already inside — this method never
   * starts its own; `MarketplaceSettlementListener` is what opens one
   * (via `retryTransaction`) for the real webhook path.
   */
  public async settle(
    paymentId: string,
    verifiedAmountMinor: number,
    verifiedCurrency: string,
    manager: EntityManager,
  ): Promise<SettlementOutcome> {
    const paymentRepo = manager.getRepository(Payment);
    const payment = await paymentRepo.findOne({ where: { id: paymentId }, lock: { mode: 'pessimistic_write' } });
    if (!payment) {
      throw new NotFoundException(biBody('Payment not found', 'عملية الدفع غير موجودة'));
    }

    const orderRepo = manager.getRepository(MarketplaceOrder);
    const order = await orderRepo.findOne({ where: { id: payment.item_id }, lock: { mode: 'pessimistic_write' } });
    if (!order) {
      throw new NotFoundException(biBody('Marketplace order not found', 'طلب السوق الاحترافي غير موجود'));
    }

    // A replayed webhook for an order already settled is a no-op — never a second enrollment/earning/ledger pair.
    if (order.status === MarketplaceOrderStatus.PAID) {
      return 'already_settled';
    }

    const currencyMatches = verifiedCurrency.toUpperCase() === order.currency.toUpperCase();
    const amountMatches = verifiedAmountMinor === order.net_amount_minor;
    if (!amountMatches || !currencyMatches) {
      await this.recordDiscrepancy(manager, payment, order, amountMatches ? 'currency_mismatch' : 'amount_mismatch');
      return 'discrepancy';
    }

    return this.grantAccess(order, manager);
  }

  /**
   * FR-111 – FR-114: the free-enrollment path (`FreeEnrollmentService`).
   * The order is created the normal way (`MarketplaceOrderService.createOrder()`,
   * `awaiting_payment`) — there is simply no `Payment` row and no gateway
   * step in between before this is called, since a zero-value order has
   * nothing to charge. Refuses outright if the order turns out not to be
   * zero-value (a paid course must never be granted through this path).
   * Idempotent the same way `settle()` is: an order already `paid` is a
   * no-op, which is what protects a concurrent double-submission.
   */
  public async settleFree(orderId: string, manager: EntityManager): Promise<SettlementOutcome> {
    const orderRepo = manager.getRepository(MarketplaceOrder);
    const order = await orderRepo.findOne({ where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
    if (!order) {
      throw new NotFoundException(biBody('Marketplace order not found', 'طلب السوق الاحترافي غير موجود'));
    }
    if (!order.is_zero_value) {
      // Defense in depth: this method must never be reachable for a real
      // paid order — that would be granting access with no payment at all.
      throw new NotFoundException(biBody('Marketplace order not found', 'طلب السوق الاحترافي غير موجود'));
    }
    if (order.status === MarketplaceOrderStatus.PAID) {
      return 'already_settled';
    }

    return this.grantAccess(order, manager);
  }

  /**
   * The one place a `MarketplaceOrder` actually becomes access: order →
   * `paid`, an `active` enrollment, and — unless `is_zero_value` (FR-114) —
   * the earning + `course_sale`/`platform_commission` ledger pair, all
   * through the caller's own `manager`. Shared by `settle()` (paid orders,
   * after the FR-104 amount/currency check) and `settleFree()` (zero-value
   * orders, which have nothing to verify).
   */
  private async grantAccess(order: MarketplaceOrder, manager: EntityManager): Promise<SettlementOutcome> {
    const orderRepo = manager.getRepository(MarketplaceOrder);
    order.status = MarketplaceOrderStatus.PAID;
    order.paid_at = order.paid_at ?? new Date();
    await orderRepo.save(order);

    const enrollmentRepo = manager.getRepository(MarketplaceEnrollment);
    const enrollment = await enrollmentRepo.save(
      enrollmentRepo.create({
        learner_id: order.learner_id,
        course_id: order.course_id,
        course_version_id: order.course_version_id,
        order_id: order.id,
        status: MarketplaceEnrollmentStatus.ACTIVE,
      }),
    );

    // FR-114: a zero-value order (free enrollment) has no earning and no ledger trace at all.
    if (!order.is_zero_value) {
      const availableAt = new Date(order.paid_at.getTime() + order.refund_window_days * 24 * 60 * 60 * 1000);
      const earning = await this.ledger.createEarning(
        {
          instructorId: order.instructor_id,
          orderId: order.id,
          grossAmountMinor: order.net_amount_minor,
          commissionAmountMinor: order.commission_amount_minor,
          netAmountMinor: order.instructor_earning_minor,
          currency: order.currency,
          commissionBps: order.commission_bps,
          availableAt,
        },
        manager,
      );
      // FR-145: "confirmed settled by the provider" is this exact moment in
      // this codebase's design — settlement only ever runs after gateway
      // confirmation — so the earning moves straight to REFUND_CLEARANCE
      // in the same transaction, rather than waiting on a separate trigger.
      await this.earnings.moveToRefundClearance(manager, earning.id);

      await this.ledger.post(
        {
          instructorId: order.instructor_id,
          orderId: order.id,
          entryType: MarketplaceLedgerEntryType.COURSE_SALE,
          amountMinor: order.instructor_earning_minor,
          currency: order.currency,
          direction: MarketplaceLedgerDirection.CREDIT,
          reference: this.ledger.buildReference(MarketplaceLedgerEntryType.COURSE_SALE, order.id, 1),
        },
        manager,
      );
      await this.ledger.post(
        {
          instructorId: order.instructor_id,
          orderId: order.id,
          entryType: MarketplaceLedgerEntryType.PLATFORM_COMMISSION,
          amountMinor: order.commission_amount_minor,
          currency: order.currency,
          direction: MarketplaceLedgerDirection.DEBIT,
          reference: this.ledger.buildReference(MarketplaceLedgerEntryType.PLATFORM_COMMISSION, order.id, 1),
        },
        manager,
      );

      this.eventEmitter.emit(
        MarketplaceEarningCreatedEvent.EVENT_NAME,
        new MarketplaceEarningCreatedEvent(earning.id, order.id, order.instructor_id),
      );
    }

    this.eventEmitter.emit(MarketplaceOrderPaidEvent.EVENT_NAME, new MarketplaceOrderPaidEvent(order.id));
    this.eventEmitter.emit(
      MarketplaceEnrollmentGrantedEvent.EVENT_NAME,
      new MarketplaceEnrollmentGrantedEvent(enrollment.id, order.id, order.learner_id, order.course_id, order.is_zero_value),
    );

    return 'settled';
  }

  /**
   * T105: the provider capture failed outright (not a mismatch — a genuine
   * decline). Only ever transitions `awaiting_payment` -> `failed`; every
   * other current status is left untouched and returns `'ignored'`. That
   * guard is what makes an *out-of-order* redelivery safe: if a `succeeded`
   * webhook already settled this order to `paid` before a `failed` webhook
   * for the same payment arrives late, this must never flip it back and
   * revoke access that was already correctly granted.
   */
  public async markFailed(paymentId: string, manager: EntityManager): Promise<FailureOutcome> {
    const paymentRepo = manager.getRepository(Payment);
    const payment = await paymentRepo.findOne({ where: { id: paymentId }, lock: { mode: 'pessimistic_write' } });
    if (!payment) {
      throw new NotFoundException(biBody('Payment not found', 'عملية الدفع غير موجودة'));
    }

    const orderRepo = manager.getRepository(MarketplaceOrder);
    const order = await orderRepo.findOne({ where: { id: payment.item_id }, lock: { mode: 'pessimistic_write' } });
    if (!order) {
      throw new NotFoundException(biBody('Marketplace order not found', 'طلب السوق الاحترافي غير موجود'));
    }

    if (order.status !== MarketplaceOrderStatus.AWAITING_PAYMENT) {
      return 'ignored';
    }

    order.status = MarketplaceOrderStatus.FAILED;
    await orderRepo.save(order);

    this.eventEmitter.emit(
      MarketplaceOrderFailedEvent.EVENT_NAME,
      new MarketplaceOrderFailedEvent(order.id, 'payment_declined'),
    );

    return 'failed';
  }

  /**
   * FR-104: grants nothing, creates no earning or ledger entry. The
   * mismatch is recorded on the shared `Payment` row's own
   * `reconciliation_status` (the same field the academic fulfillment-
   * compensation path already uses — see `GatewayFinancialStateMachineService`)
   * so it surfaces through whatever reconciliation tooling already watches
   * that column, plus a `PaymentAuditLog` row and a domain event a future
   * notification listener can react to (T119).
   */
  private async recordDiscrepancy(
    manager: EntityManager,
    payment: Payment,
    order: MarketplaceOrder,
    reason: 'amount_mismatch' | 'currency_mismatch',
  ): Promise<void> {
    const message = `Marketplace payment ${payment.id} for order ${order.id}: ${reason}`;
    this.logger.error(message);

    const paymentRepo = manager.getRepository(Payment);
    // The row is already locked from settle()'s own load — this save just persists the mutation.
    payment.reconciliation_status = 'reconciliation_required';
    payment.reconciliation_last_provider_error = message;
    payment.failure_reason = `reconciliation_required: ${reason}`;
    await paymentRepo.save(payment);

    await manager.getRepository(PaymentAuditLog).insert({
      actor_id: null,
      action: 'marketplace_payment_discrepancy',
      resource_type: 'payment',
      resource_id: payment.id,
      details: { order_id: order.id, reason, expected_amount_minor: order.net_amount_minor, expected_currency: order.currency },
      ip_address: null,
    });

    this.eventEmitter.emit(
      MarketplacePaymentDiscrepancyEvent.EVENT_NAME,
      new MarketplacePaymentDiscrepancyEvent(order.id, payment.id, order.learner_id, reason),
    );
  }
}
