import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CronSingleRunner } from '../../common/utils/cron-lock.util';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { exponentialRetryDelayMs } from '../../common/utils/backoff.util';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { FEATURE_FLAGS, isFeatureEnabled } from '../../config/feature-flags';
import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { ScheduledJobMonitorService } from '../../observability/scheduled-job-monitor.service';
import { LessonSessionBookingStatus } from '../../lessons/entities/lesson-session-booking-status.enum';
import { LessonSessionsService } from '../../lessons/lesson-sessions.service';
import {
  FinancialMaintenanceRun,
  ItemType,
  Order,
  OrderStatus,
  Payment,
  PaymentAuditLog,
  PaymentDomainEvent,
  PaymentStatus,
  Refund,
  RefundStatus,
} from '../entities';
import { FinancialReportsService } from './financial-reports.service';
import { PaymentProviderRegistry } from './payment-provider-registry.service';
import { CartCheckoutService } from './cart-checkout.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { SettlementsService } from './settlements.service';

/** How long after creation an EXPIRED payment keeps being re-inquired for late captures (F-28). */
const EXPIRED_RECONCILIATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
    @InjectRepository(FinancialMaintenanceRun)
    private readonly maintenanceRuns: Repository<FinancialMaintenanceRun>,
    private readonly dataSource: DataSource,
    private readonly discounts: DiscountCodesService,
    private readonly settlements: SettlementsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly providers: PaymentProviderRegistry,
    private readonly paymentService: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly jobMonitor: ScheduledJobMonitorService,
    private readonly lessonSessions: LessonSessionsService,
    private readonly cartCheckout: CartCheckoutService,
    private readonly reports: FinancialReportsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  public async runMaintenance(): Promise<void> {
    // Financial sweep. Enabled unless ENABLE_PAYMENT_RECONCILIATION is exactly
    // "false", so production — which sets nothing — is unchanged.
    if (!isFeatureEnabled(FEATURE_FLAGS.PAYMENT_RECONCILIATION)) {
      this.logger.log(
        JSON.stringify({ finance_maintenance: 'skipped', reason: 'feature_flag_disabled' }),
      );
      return;
    }

    // Execution monitoring for the CYCLE. The per-task rows written by
    // `runMonitoredMaintenanceTask` below record what each task did; this
    // records that the cron fired at all — a wedged scheduler writes neither a
    // success nor a failure row, and was previously invisible.
    await this.jobMonitor.run('payments.finance_maintenance', async () =>
      this.runMaintenanceCycle(),
    );
  }

  private async runMaintenanceCycle(): Promise<void> {
    const guard = this.dataSource.createQueryRunner();
    await guard.connect();
    try {
      const result = (await guard.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`, [
        'finance-maintenance-v1',
      ])) as Array<{ acquired: boolean }>;
      if (!result[0]?.acquired) {
        this.logger.log(
          JSON.stringify({ finance_maintenance: 'skipped', reason: 'worker_lock_held' }),
        );
        return;
      }
      // Each task is deliberately isolated. A failed order expiry must not
      // block earned-fund release or the outbox, and the PostgreSQL session
      // lock prevents another worker from running the same cycle concurrently.
      await this.runMonitoredMaintenanceTask('expire_orders', () => this.expireOrders());
      await this.runMonitoredMaintenanceTask('expire_cart_checkouts', () =>
        this.cartCheckout.expireDueCheckouts(),
      );
      await this.runMonitoredMaintenanceTask('expire_lesson_session_holds', () =>
        this.lessonSessions.expireStaleHolds(),
      );
      await this.runMonitoredMaintenanceTask('sweep_stuck_meeting_provisioning', () =>
        this.lessonSessions.sweepStuckMeetingProvisioning(),
      );
      await this.runMonitoredMaintenanceTask('release_cancelled_session_meetings', () =>
        this.lessonSessions.sweepCancelledSessionMeetings(),
      );
      await this.runMonitoredMaintenanceTask('release_held_earnings', () =>
        this.settlements.releaseAvailableEarnings(),
      );
      await this.runMonitoredMaintenanceTask('notify_overdue_payouts', () =>
        this.settlements.notifyOverduePayouts(),
      );
      await this.runMonitoredMaintenanceTask('publish_outbox', () => this.publishOutbox());
      // T041: pre-warms the reconciliation-warnings snapshot so a miss costs an admin visitor at
      // most once per TTL; `getOrCompute` only recomputes when the cached entry is absent/expired.
      await this.runMonitoredMaintenanceTask(
        'warm_reconciliation_warnings',
        async () => (await this.reports.reportReconciliationWarnings()).length,
      );
    } finally {
      try {
        await guard.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['finance-maintenance-v1']);
      } finally {
        await guard.release();
      }
    }
  }

  private async runMonitoredMaintenanceTask(
    taskName: string,
    task: () => Promise<number>,
  ): Promise<void> {
    const startedAt = new Date();
    let run: FinancialMaintenanceRun | null = null;
    try {
      run = await this.maintenanceRuns.save(
        this.maintenanceRuns.create({
          task_name: taskName,
          worker_id: `finance:${process.pid}`,
          status: 'running',
          started_at: startedAt,
          finished_at: null,
          duration_ms: 0,
          processed_count: 0,
          released_count: 0,
          error_count: 0,
          error_message: null,
        }),
      );
    } catch (error) {
      this.logger.error(`Unable to start finance maintenance monitor for ${taskName}`, error);
    }
    try {
      const processed = await task();
      if (run) {
        run.status = 'succeeded';
        run.finished_at = new Date();
        run.duration_ms = run.finished_at.getTime() - startedAt.getTime();
        run.processed_count = processed;
        run.released_count = taskName === 'release_held_earnings' ? processed : 0;
        try {
          await this.maintenanceRuns.save(run);
        } catch (monitorError) {
          this.logger.error(
            `Unable to complete finance maintenance monitor for ${taskName}`,
            monitorError,
          );
        }
      }
      this.logger.log(
        JSON.stringify({
          finance_maintenance: taskName,
          status: run?.status ?? 'succeeded',
          duration_ms: run?.duration_ms ?? Date.now() - startedAt.getTime(),
          processed_count: processed,
          released_count: taskName === 'release_held_earnings' ? processed : 0,
          error_count: 0,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown maintenance failure';
      if (run) {
        run.status = 'failed';
        run.finished_at = new Date();
        run.duration_ms = run.finished_at.getTime() - startedAt.getTime();
        run.error_count = 1;
        run.error_message = message;
        try {
          await this.maintenanceRuns.save(run);
        } catch (monitorError) {
          this.logger.error(
            `Unable to fail finance maintenance monitor for ${taskName}`,
            monitorError,
          );
        }
      }
      this.logger.error(
        JSON.stringify({
          finance_maintenance: taskName,
          status: run?.status ?? 'failed',
          duration_ms: run?.duration_ms ?? Date.now() - startedAt.getTime(),
          processed_count: 0,
          released_count: 0,
          error_count: 1,
          error: message,
        }),
      );
      try {
        await this.emitRepeatedMaintenanceFailureAlert(taskName, message);
      } catch (alertError) {
        this.logger.error(`Unable to emit finance maintenance alert for ${taskName}`, alertError);
      }
    }
  }

  private async emitRepeatedMaintenanceFailureAlert(
    taskName: string,
    error: string,
  ): Promise<void> {
    const recent = await this.maintenanceRuns
      .createQueryBuilder('run')
      .where('run.task_name = :taskName', { taskName })
      .orderBy('run.started_at', 'DESC')
      .take(3)
      .getMany();
    if (recent.length !== 3 || recent.some((run) => run.status !== 'failed')) return;
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(PaymentDomainEvent)
      .values({
        event_name: 'finance.maintenance.repeated_failure',
        dedupe_key: `finance-maintenance:${taskName}:${Math.floor(Date.now() / 3_600_000)}`,
        payload: { task_name: taskName, error, failures: 3 },
        published_at: null,
        attempts: 0,
        last_error: null,
      } as never)
      .orIgnore()
      .execute();
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  // Re-queries the provider and transitions payments: one replica per tick, like the other financial crons.
  @CronSingleRunner('payments.gateway_reconciliation')
  public async reconcileGatewayAttempts(): Promise<void> {
    // Same financial flag as runMaintenance: this re-queries the provider for
    // pending/processing/expired payments and can transition them.
    if (!isFeatureEnabled(FEATURE_FLAGS.PAYMENT_RECONCILIATION)) {
      this.logger.log(
        JSON.stringify({ gateway_reconciliation: 'skipped', reason: 'feature_flag_disabled' }),
      );
      return;
    }

    await this.jobMonitor.run('payments.gateway_reconciliation', async () =>
      this.reconcileGatewayAttemptsCycle(),
    );
  }

  private async reconcileGatewayAttemptsCycle(): Promise<void> {
    let lastCreatedAt: Date | null = null;
    let lastId: string | null = null;
    for (;;) {
      const query = this.payments
        .createQueryBuilder('payment')
        .where('payment.status IN (:...statuses)', {
          statuses: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.EXPIRED],
        })
        .andWhere(
          '(payment.order_id IS NOT NULL OR (payment.cart_checkout_id IS NOT NULL AND payment.order_id IS NULL))',
        )
        // Only the active gateway can be inquired; historical rows of a retired
        // provider are kept as-is and must not be re-reconciled.
        .andWhere('payment.provider = :activeProvider', {
          activeProvider: this.providers.getDefault().name,
        })
        .andWhere(
          '(payment.provider_order_reference IS NOT NULL OR payment.provider_reference IS NOT NULL)',
        )
        .andWhere(
          "(payment.failure_reason IS NULL OR payment.failure_reason NOT LIKE 'reconciliation_quarantine:%')",
        )
        // F-28: an EXPIRED payment can still receive a late capture, but not forever. Beyond the window
        // it is no longer re-inquired, so the scan stays bounded as expired rows accumulate.
        .andWhere('(payment.status <> :expiredStatus OR payment.created_at > :expiredCutoff)', {
          expiredStatus: PaymentStatus.EXPIRED,
          expiredCutoff: new Date(Date.now() - EXPIRED_RECONCILIATION_WINDOW_MS),
        })
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
      const providerOrderReference = payment.provider_order_reference ?? payment.provider_reference;
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
    const nextRetryAt = new Date(Date.now() + exponentialRetryDelayMs(attempts));
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

  /**
   * Customer-facing return from the hosted page. The browser redirect carries
   * no trusted facts, so this only (a) resolves where to send the customer and
   * (b) nudges a rate-limited server-side inquiry for a still-open payment so a
   * slow callback does not leave the customer waiting. Access is only ever
   * granted by the verified callback/inquiry path, never from this request.
   */
  public async resolveHostedReturn(
    paymentId: string,
  ): Promise<{ kind: 'order' | 'marketplace' | 'cart' | 'unknown'; id: string | null }> {
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) return { kind: 'unknown', id: null };
    const open = [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.EXPIRED].includes(
      payment.status,
    );
    const recentlyChecked =
      payment.reconciliation_last_attempted_at !== null &&
      Date.now() - payment.reconciliation_last_attempted_at.getTime() < 30_000;
    if (
      open &&
      !recentlyChecked &&
      payment.provider === this.providers.getDefault().name &&
      payment.provider_order_reference !== null
    ) {
      try {
        await this.reconcilePayment(payment);
      } catch (error) {
        this.logger.warn(
          `Return-triggered reconciliation failed for payment ${payment.id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
    if (payment.item_type === ItemType.MARKETPLACE_COURSE) {
      return { kind: 'marketplace', id: payment.item_id };
    }
    if (payment.cart_checkout_id !== null && payment.order_id === null) {
      return { kind: 'cart', id: payment.cart_checkout_id };
    }
    return payment.order_id === null
      ? { kind: 'unknown', id: null }
      : { kind: 'order', id: payment.order_id };
  }

  private async reconcilePayment(candidate: Payment): Promise<void> {
    const payment = await this.claimPaymentReconciliation(candidate.id);
    if (!payment) return;
    try {
      const provider = this.providers.get(payment.provider!);
      const providerOrderReference = payment.provider_order_reference ?? payment.provider_reference;
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
      if (details.status === 'succeeded') {
        await this.paymentService.processSuccessfulPayment(payment.id, {
          amountCents: details.amountMinor,
          currency: details.currency,
          transactionId: details.transactionId,
          ...(details.occurredAt === undefined ? {} : { occurredAt: details.occurredAt }),
        });
        await this.finishPaymentReconciliation(payment);
        return;
      }
      if (details.status === 'refunded') {
        await this.paymentService.processSuccessfulPayment(payment.id, {
          amountCents: details.amountMinor,
          currency: details.currency,
          transactionId: details.transactionId,
          ...(details.occurredAt === undefined ? {} : { occurredAt: details.occurredAt }),
        });
        await this.paymentService.processRefundedPayment(payment.id, {
          amountCents: details.amountMinor,
          currency: details.currency,
          transactionId: details.transactionId,
          ...(details.occurredAt === undefined ? {} : { occurredAt: details.occurredAt }),
        });
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
    const nextRetryAt = new Date(Date.now() + exponentialRetryDelayMs(attempts));
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
        await this.lessonSessions.markForOrder(
          manager,
          order.id,
          LessonSessionBookingStatus.EXPIRED,
        );
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
        // MP-12: with the marketplace switched off nothing listens for these, and `emitAsync` would
        // resolve with no handler and mark a captured payment "published" without ever enrolling the
        // learner. Keep it queued (no attempt consumed) so it settles once the module is enabled.
        if (
          event.event_name.startsWith('payment.marketplace_') &&
          this.eventEmitter.listenerCount(event.event_name) === 0
        ) {
          await this.deferOutboxEvent(event.id, event.lease_token!);
          continue;
        }
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

  /** Hands a claimed event back unpublished, without counting the claim as an attempt. */
  private async deferOutboxEvent(eventId: string, leaseToken: string): Promise<void> {
    await this.events
      .createQueryBuilder()
      .update(PaymentDomainEvent)
      .set({
        status: 'pending',
        attempts: () => 'GREATEST(attempts - 1, 0)',
        last_error: 'Deferred: no listener registered (marketplace module disabled)',
        lease_token: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        next_retry_at: new Date(Date.now() + 5 * 60_000),
      })
      .where('id = :id AND status = :status AND lease_token = :leaseToken', {
        id: eventId,
        status: 'processing',
        leaseToken,
      })
      .execute();
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
        : new Date(Date.now() + exponentialRetryDelayMs(event.attempts));
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
}
