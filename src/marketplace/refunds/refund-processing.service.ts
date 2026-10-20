import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Not } from 'typeorm';

import { Certificate } from '../../certificates/entities/certificate.entity';
import { CertificateStatus } from '../../certificates/entities/certificate-status.enum';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { Payment } from '../../payments/entities/payment.entity';
import { PaymentProviderRegistry } from '../../payments/services/payment-provider-registry.service';
import { MarketplaceEnrollment, MarketplaceOrder } from '../commerce/entities';
import {
  InstructorEarningStatus,
  MarketplaceEnrollmentStatus,
  MarketplaceLedgerDirection,
  MarketplaceLedgerEntryType,
  MarketplaceOrderStatus,
  RefundRequestStatus,
} from '../common/enums';
import { BalanceService } from '../earnings/balance.service';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { LedgerService } from '../earnings/ledger.service';
import {
  MarketplaceEarningReversedEvent,
  MarketplaceRefundCompletedEvent,
  MarketplaceRefundFailedEvent,
} from '../events/domain.events';
import { MarketplaceCourseReview } from '../reviews/entities/marketplace-course-review.entity';
import { MarketplaceRefundRequest } from './entities';

interface ClaimResult {
  request: MarketplaceRefundRequest;
  alreadyDone: boolean;
}

/**
 * T136 – T138. `process()` is the single entry point for turning an
 * APPROVED refund request into money actually moving back and every
 * dependent record reversed. Two phases, deliberately separate:
 *
 * 1. `claim()` + the gateway call — outside any reversal transaction, since
 *    network I/O must never hold a Postgres row lock.
 * 2. `completeReversal()` — one all-or-nothing transaction that only ever
 *    runs after the gateway has confirmed the money actually moved
 *    (FR-187 – FR-191, FR-193, FR-194).
 *
 * A thrown error or an unconfirmed ("processing") gateway response is
 * treated identically: fail closed, nothing reversed, the request marked
 * FAILED with a reason (T138). Calling `process()` again later — including
 * on an already-FAILED request — retries from a clean state, since a
 * failed attempt never touched the ledger, enrollment or certificate.
 */
@Injectable()
export class RefundProcessingService {
  private readonly logger = new Logger(RefundProcessingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly balance: BalanceService,
    private readonly providers: PaymentProviderRegistry,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async process(refundRequestId: string): Promise<MarketplaceRefundRequest> {
    const claimed = await retryTransaction(this.dataSource, (manager) =>
      this.claim(manager, refundRequestId),
    );
    if (claimed.alreadyDone) {
      return claimed.request;
    }
    const request = claimed.request;

    const order = await this.dataSource
      .getRepository(MarketplaceOrder)
      .findOne({ where: { id: request.order_id } });
    if (!order) {
      return retryTransaction(this.dataSource, (manager) =>
        this.markFailed(manager, request.id, 'Order not found'),
      );
    }

    let providerReference: string;
    try {
      providerReference = await this.callGateway(order, request.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown provider error';
      this.logger.error(`Marketplace refund ${request.id} failed at the provider: ${reason}`);
      return retryTransaction(this.dataSource, (manager) =>
        this.markFailed(manager, request.id, reason),
      );
    }

    return retryTransaction(this.dataSource, (manager) =>
      this.completeReversal(manager, request.id, providerReference),
    );
  }

  private async callGateway(order: MarketplaceOrder, refundRequestId: string): Promise<string> {
    const payment = order.payment_id
      ? await this.dataSource.getRepository(Payment).findOne({ where: { id: order.payment_id } })
      : null;
    if (!payment?.provider || !payment.provider_reference) {
      throw new Error('Order has no reconcilable provider reference');
    }
    const provider = this.providers.get(payment.provider);
    if (!provider.supportsRefunds()) {
      throw new Error(`Configured gateway (${payment.provider}) does not support API refunds`);
    }
    const result = await provider.refund({
      providerReference: payment.provider_reference,
      amountMinor: order.net_amount_minor,
      currency: order.currency,
      idempotencyKey: `marketplace-refund:${refundRequestId}`,
    });
    if (result.status !== 'succeeded') {
      // "Accepted but not yet confirmed" is ambiguous, not a green light to
      // reverse our own ledger — treated the same as a thrown error (T138).
      throw new Error(`Gateway refund is not yet confirmed (status=${result.status})`);
    }
    return result.providerReference;
  }

  private async claim(manager: EntityManager, refundRequestId: string): Promise<ClaimResult> {
    const request = await manager.findOne(MarketplaceRefundRequest, {
      where: { id: refundRequestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request) {
      throw new NotFoundException(biBody('Refund request not found', 'طلب الاسترداد غير موجود'));
    }
    if (request.status === RefundRequestStatus.COMPLETED) {
      return { request, alreadyDone: true };
    }
    if (request.status === RefundRequestStatus.PROCESSING) {
      throw new ConflictException(
        biBody('This refund is already being processed', 'يجري بالفعل معالجة هذا الاسترداد'),
      );
    }
    if (
      request.status !== RefundRequestStatus.APPROVED &&
      request.status !== RefundRequestStatus.FAILED
    ) {
      throw new ConflictException(
        biBody(
          'This refund request must be approved before it can be processed',
          'يجب الموافقة على طلب الاسترداد هذا قبل معالجته',
        ),
      );
    }

    // An order is refunded at most once. The open-request unique index only stops two requests
    // being in flight together; once one has COMPLETED it leaves that index, so an older FAILED
    // (or REJECTED, then discretionarily approved) request for the same order could otherwise be
    // claimed and sent to the provider a second time — with its own idempotency key. Nothing is
    // sent: the request is closed FAILED with the reason, and no refund-failed notification goes
    // to a learner who has in fact been refunded.
    const order = await manager.findOne(MarketplaceOrder, {
      where: { id: request.order_id },
      lock: { mode: 'pessimistic_write' },
    });
    const completedSibling = await manager.findOne(MarketplaceRefundRequest, {
      where: {
        order_id: request.order_id,
        id: Not(request.id),
        status: RefundRequestStatus.COMPLETED,
      },
    });
    if (order?.status === MarketplaceOrderStatus.REFUNDED || completedSibling) {
      request.status = RefundRequestStatus.FAILED;
      request.failure_reason = completedSibling
        ? `Order already refunded by refund request ${completedSibling.id}; no second refund was sent to the provider`
        : 'Order already refunded; no second refund was sent to the provider';
      const closed = await manager.save(MarketplaceRefundRequest, request);
      this.logger.warn(
        `Marketplace refund ${request.id} not sent: order ${request.order_id} is already refunded.`,
      );
      return { request: closed, alreadyDone: true };
    }

    request.status = RefundRequestStatus.PROCESSING;
    request.failure_reason = null;
    const saved = await manager.save(MarketplaceRefundRequest, request);
    return { request: saved, alreadyDone: false };
  }

  private async markFailed(
    manager: EntityManager,
    refundRequestId: string,
    reason: string,
  ): Promise<MarketplaceRefundRequest> {
    const request = await manager.findOne(MarketplaceRefundRequest, {
      where: { id: refundRequestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request) {
      throw new NotFoundException(biBody('Refund request not found', 'طلب الاسترداد غير موجود'));
    }
    // Never regress a refund a concurrent attempt already completed.
    if (request.status === RefundRequestStatus.COMPLETED) {
      return request;
    }
    request.status = RefundRequestStatus.FAILED;
    request.failure_reason = reason;
    const saved = await manager.save(MarketplaceRefundRequest, request);
    this.eventEmitter.emit(
      MarketplaceRefundFailedEvent.EVENT_NAME,
      new MarketplaceRefundFailedEvent(saved.id, saved.order_id, reason),
    );
    return saved;
  }

  /**
   * The one atomic step (FR-187 – FR-191). Enrollment and certificate are
   * mutated directly on this manager rather than through
   * `EnrollmentService.revoke()` / `CertificatesService.revokeCertificate()`
   * — neither accepts a transactional manager, and going through them here
   * would silently break atomicity. Every mutation is individually guarded
   * by its own already-applied check, so a retry after a partial crash
   * (unlikely inside one Postgres transaction, but cheap to make certain)
   * or a second call after COMPLETED never double-applies anything.
   */
  private async completeReversal(
    manager: EntityManager,
    refundRequestId: string,
    providerReference: string,
  ): Promise<MarketplaceRefundRequest> {
    const request = await manager.findOne(MarketplaceRefundRequest, {
      where: { id: refundRequestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request) {
      throw new NotFoundException(biBody('Refund request not found', 'طلب الاسترداد غير موجود'));
    }
    if (request.status === RefundRequestStatus.COMPLETED) {
      return request;
    }

    const order = await manager.findOne(MarketplaceOrder, {
      where: { id: request.order_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    if (order.status !== MarketplaceOrderStatus.REFUNDED) {
      order.status = MarketplaceOrderStatus.REFUNDED;
      order.refunded_at = new Date();
      await manager.save(MarketplaceOrder, order);
    }

    const revocationReason = request.is_removal_driven
      ? 'Course permanently removed'
      : 'Refund completed';

    const enrollment = await manager.findOne(MarketplaceEnrollment, {
      where: { id: request.enrollment_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (enrollment && enrollment.status !== MarketplaceEnrollmentStatus.REVOKED) {
      enrollment.status = MarketplaceEnrollmentStatus.REVOKED;
      enrollment.revoked_at = new Date();
      enrollment.revocation_reason = revocationReason;
      await manager.save(MarketplaceEnrollment, enrollment);
    }

    const certificate = await manager.findOne(Certificate, {
      where: { student_id: request.learner_id, marketplace_course_id: order.course_id },
    });
    if (certificate && certificate.status !== CertificateStatus.REVOKED) {
      certificate.status = CertificateStatus.REVOKED;
      certificate.revoked_at = new Date();
      certificate.revoke_reason = revocationReason;
      certificate.revocation_context = { source: 'refund' };
      certificate.is_public = false;
      await manager.save(Certificate, certificate);
    }

    const review = await manager.findOne(MarketplaceCourseReview, {
      where: { learner_id: request.learner_id, course_id: order.course_id },
    });
    if (review && !review.withdrawn_at) {
      review.withdrawn_at = new Date();
      await manager.save(MarketplaceCourseReview, review);
    }

    const earning = await manager.findOne(InstructorEarning, {
      where: { order_id: order.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (earning && earning.status !== InstructorEarningStatus.REVERSED) {
      const wasPaidOut = earning.status === InstructorEarningStatus.PAID_OUT;
      earning.status = InstructorEarningStatus.REVERSED;
      earning.reversed_at = new Date();
      earning.reversal_reason = revocationReason;
      await manager.save(InstructorEarning, earning);
      this.eventEmitter.emit(
        MarketplaceEarningReversedEvent.EVENT_NAME,
        new MarketplaceEarningReversedEvent(earning.id, order.id, earning.instructor_id),
      );

      // Original sale/commission entries are never edited — these are new,
      // independent rows that net the balance out (FR-190).
      await this.ledger.post(
        {
          instructorId: earning.instructor_id,
          orderId: order.id,
          entryType: MarketplaceLedgerEntryType.REFUND,
          amountMinor: earning.net_amount_minor,
          currency: earning.currency,
          direction: MarketplaceLedgerDirection.CREDIT,
          reference: `refund:${request.id}:earning-reversal`,
          sourceEventId: request.id,
          sourceEventType: 'marketplace.refund.completed',
        },
        manager,
      );
      await this.ledger.post(
        {
          instructorId: earning.instructor_id,
          orderId: order.id,
          entryType: MarketplaceLedgerEntryType.REFUND_COMMISSION_REVERSAL,
          amountMinor: earning.commission_amount_minor,
          currency: earning.currency,
          direction: MarketplaceLedgerDirection.CREDIT,
          reference: `refund:${request.id}:commission-reversal`,
          sourceEventId: request.id,
          sourceEventType: 'marketplace.refund.completed',
        },
        manager,
      );

      if (wasPaidOut) {
        // FR-195, FR-196 — recorded in full; nothing left on this earning to claw back from.
        await this.balance.recordShortfall(
          manager,
          earning.instructor_id,
          earning.net_amount_minor,
          earning.currency,
          request.id,
        );
      }
    }

    request.status = RefundRequestStatus.COMPLETED;
    request.decided_at = request.decided_at ?? new Date();
    request.progress_bps_at_processing =
      enrollment?.progress_bps ?? request.progress_bps_at_request;
    request.refund_reference = providerReference;
    request.failure_reason = null;
    const saved = await manager.save(MarketplaceRefundRequest, request);

    this.eventEmitter.emit(
      MarketplaceRefundCompletedEvent.EVENT_NAME,
      new MarketplaceRefundCompletedEvent(
        saved.id,
        order.id,
        request.learner_id,
        order.instructor_id,
        request.is_removal_driven,
      ),
    );

    return saved;
  }
}
