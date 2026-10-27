import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { Book } from '../../books/entities/book.entity';
import { BookPurchase } from '../../books/entities/book-purchase.entity';
import { CertificateEligibilityService } from '../../certificates/certificate-eligibility.service';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import {
  acquireTeacherFinancialLock,
  retryTransaction,
} from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { LessonSessionsService } from '../../lessons/lesson-sessions.service';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationOrigin } from '../../notifications/entities/notification-origin.enum';
import { NotificationStatus } from '../../notifications/entities/notification-status.enum';
import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { CompleteRefundDto, CreateRefundDto, RefundFilterDto } from '../dto';
import {
  CollectionParty,
  Entitlement,
  EntitlementStatus,
  FinancialLedgerEntry,
  ItemType,
  LedgerDirection,
  LedgerEntryStatus,
  LedgerEntryType,
  LessonPurchase,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentAuditLog,
  PaymentChannel,
  PaymentStatus,
  Refund,
  RefundAttempt,
  RefundStatus,
} from '../entities';
import { PaymentProviderRegistry } from './payment-provider-registry.service';
import { writeDomainEvent, writePaymentAudit } from '../finance-persistence';

/**
 * Requested/completed refund amount exceeds the order's remaining refundable
 * balance. Distinct from an unsupported-partial-refund case — partial refunds
 * are fully supported (see `PARTIALLY_REFUNDED` order status below); this
 * code fires only when the amount itself is too large.
 */
export const REFUND_AMOUNT_EXCEEDS_REMAINING_CODE = 'REFUND_AMOUNT_EXCEEDS_REMAINING';

function refundAmountExceedsRemaining(): { code: string; message: string; message_ar: string } {
  return {
    code: REFUND_AMOUNT_EXCEEDS_REMAINING_CODE,
    ...biBody(
      'Requested refund amount exceeds the remaining refundable amount',
      'مبلغ الاسترداد المطلوب أكبر من المبلغ المتبقي القابل للاسترداد',
    ),
  };
}

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectRepository(Refund)
    private readonly refunds: Repository<Refund>,
    @InjectRepository(RefundAttempt)
    private readonly refundAttempts: Repository<RefundAttempt>,
    private readonly dataSource: DataSource,
    private readonly providers: PaymentProviderRegistry,
    private readonly lessonSessions: LessonSessionsService,
    private readonly certificateEligibility: CertificateEligibilityService,
  ) {}

  public async request(dto: CreateRefundDto, adminId: string): Promise<Refund> {
    return retryTransaction(this.dataSource, async (manager) => {
      await acquireTeacherFinancialLock(
        manager,
        await this.teacherIdForOrder(manager, dto.order_id),
      );
      const order = await manager.findOne(Order, {
        where: { id: dto.order_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order || ![OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED].includes(order.status)) {
        throw new ConflictException(
          biBody('Only a paid order can be refunded', 'يمكن استرداد الطلب المدفوع فقط'),
        );
      }
      const remaining = order.final_amount_minor - order.refunded_amount_minor;
      if (dto.amount_minor > remaining) {
        throw new BadRequestException(refundAmountExceedsRemaining());
      }
      const existing = await manager.findOne(Refund, {
        where: {
          order_id: order.id,
          status: In([RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING]),
        },
      });
      if (existing) {
        throw new ConflictException(
          biBody('A refund is already in progress', 'يوجد طلب استرداد قيد التنفيذ'),
        );
      }
      const refund = await manager.save(
        Refund,
        manager.create(Refund, {
          order_id: order.id,
          payment_id: order.payment_id,
          channel: order.payment_channel,
          amount_minor: dto.amount_minor,
          currency: order.currency,
          status: RefundStatus.REQUESTED,
          reason_code: dto.reason_code,
          reason: dto.reason?.trim() ?? null,
          internal_note: dto.internal_note?.trim() ?? null,
          external_method: null,
          external_reference: null,
          proof_file_key: null,
          requested_by: adminId,
          approved_by: null,
          completed_by: null,
          completed_at: null,
          metadata: {
            entitlement_policy:
              dto.amount_minor === remaining ? 'revoke_on_full_refund' : 'retain_on_partial_refund',
          },
        }),
      );
      await this.audit(manager, adminId, 'refund_requested', refund, {
        order_id: order.id,
        amount_minor: refund.amount_minor,
        reason_code: refund.reason_code,
        entitlement_policy: refund.metadata?.['entitlement_policy'],
      });
      await writeDomainEvent(manager, 'refund.requested', `refund:${refund.id}:requested`, {
        refund_id: refund.id,
        order_id: order.id,
      });
      return refund;
    });
  }

  public async processGateway(refundId: string, adminId: string): Promise<Refund> {
    return this.processGatewayClaimed(refundId, adminId);
  }

  private async processGatewayClaimed(refundId: string, adminId: string): Promise<Refund> {
    const claimed = await retryTransaction(this.dataSource, async (manager) => {
      const refund = await manager.findOne(Refund, {
        where: { id: refundId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!refund || refund.channel !== PaymentChannel.GATEWAY || !refund.payment_id) {
        throw new NotFoundException(biBody('Gateway refund not found', 'Gateway refund not found'));
      }
      if (refund.requested_by === adminId) {
        throw new ConflictException(
          biBody(
            'Refund requester cannot dispatch the same gateway refund',
            'Refund requester cannot dispatch the same gateway refund',
          ),
        );
      }
      if (refund.status === RefundStatus.SUCCEEDED) return { refund, payment: null, attempt: null };
      const payment = await manager.findOne(Payment, {
        where: { id: refund.payment_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment?.provider || !payment.provider_reference) {
        throw new ConflictException(
          biBody(
            'Payment has no reconcilable provider reference',
            'Payment has no reconcilable provider reference',
          ),
        );
      }
      // Check the capability BEFORE claiming: committing a PROCESSING refund plus a `claimed` attempt and
      // only then discovering the gateway has no refund API left the refund stuck forever (F-06). A
      // gateway without one is refunded in its own dashboard and completed through the manual path.
      if (!this.providers.get(payment.provider).supportsRefunds()) {
        throw new ConflictException(
          biBody(
            'This payment gateway has no refund API. Refund the payment in the gateway dashboard, then complete this refund manually with the provider reference.',
            'This payment gateway has no refund API. Refund the payment in the gateway dashboard, then complete this refund manually with the provider reference.',
          ),
        );
      }
      const activeAttempt = await manager
        .createQueryBuilder(RefundAttempt, 'attempt')
        .where('attempt.refund_id = :refundId', { refundId: refund.id })
        .andWhere("attempt.status IN ('claimed', 'sending', 'reconciliation_required')")
        .setLock('pessimistic_write')
        .getOne();
      if (activeAttempt) {
        if (activeAttempt.status === 'reconciliation_required') {
          throw new ConflictException(
            biBody(
              'Gateway refund outcome is ambiguous and requires provider confirmation or a reviewed retry',
              'Gateway refund outcome is ambiguous and requires provider confirmation or a reviewed retry',
            ),
          );
        }
        throw new ConflictException(
          biBody(
            'Gateway refund is already being processed',
            'Gateway refund is already being processed',
          ),
        );
      }
      const sequence = await manager
        .createQueryBuilder(RefundAttempt, 'attempt')
        .select('COALESCE(MAX(attempt.attempt_number), 0)', 'number')
        .where('attempt.refund_id = :refundId', { refundId: refund.id })
        .getRawOne<{ number: string }>();
      const now = new Date();
      const attempt = manager.create(RefundAttempt, {
        refund_id: refund.id,
        attempt_number: Number(sequence?.number ?? 0) + 1,
        idempotency_key: `refund:${refund.id}:attempt:${Number(sequence?.number ?? 0) + 1}`,
        status: 'claimed',
        provider_request_reference: payment.provider_reference,
        provider_refund_id: null,
        claimed_by: `admin:${adminId}`,
        claimed_at: now,
        lease_expires_at: new Date(now.getTime() + 5 * 60_000),
        started_at: now,
        completed_at: null,
        next_retry_at: null,
        attempt_count: 1,
        last_error: null,
      });
      refund.status = RefundStatus.PROCESSING;
      refund.approved_by = adminId;
      await manager.save(Refund, refund);
      await manager.save(RefundAttempt, attempt);
      return { refund, payment, attempt };
    });
    if (claimed.payment === null) return claimed.refund;
    const { refund, payment, attempt } = claimed;
    if (!attempt) return refund;
    const provider = this.providers.get(payment.provider);
    if (!provider.supportsRefunds()) {
      throw new ConflictException(
        biBody(
          'Configured gateway does not support API refunds',
          'Configured gateway does not support API refunds',
        ),
      );
    }
    try {
      await this.refundAttempts.update(
        { id: attempt.id, status: 'claimed' },
        { status: 'sending', started_at: new Date() },
      );
      const providerResult = await provider.refund({
        providerReference: payment.provider_reference!,
        amountMinor: refund.amount_minor,
        currency: refund.currency,
        idempotencyKey: attempt.idempotency_key,
      });
      if (providerResult.status === 'succeeded') {
        await this.refundAttempts.update(attempt.id, {
          status: 'succeeded',
          provider_refund_id: providerResult.providerReference,
          completed_at: new Date(),
          lease_expires_at: null,
          last_error: null,
        });
        return this.complete(
          refund.id,
          {
            external_method: payment.provider!,
            external_reference: providerResult.providerReference,
          },
          adminId,
          true,
        );
      }
      await this.refundAttempts.update(attempt.id, {
        status: 'reconciliation_required',
        provider_refund_id: providerResult.providerReference,
        lease_expires_at: null,
        next_retry_at: null,
        last_error: 'Provider accepted refund but did not confirm completion',
      });
      return (await this.refunds.findOne({ where: { id: refund.id } })) ?? refund;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Gateway refund request failed';
      // The available inquiry describes the original payment transaction. It
      // cannot prove a refund did not occur, so an ambiguous call is fail-closed.
      await this.refundAttempts.update(attempt.id, {
        status: 'reconciliation_required',
        lease_expires_at: null,
        next_retry_at: null,
        last_error: errorMessage,
      });
      this.logger.error(`Gateway refund ${refund.id} has an ambiguous provider outcome`);
      throw error;
    }
  }

  public async complete(
    refundId: string,
    dto: CompleteRefundDto,
    adminId: string,
    providerVerified = false,
    transactionManager?: EntityManager,
  ): Promise<Refund> {
    const execute = async (manager: EntityManager): Promise<Refund> => {
      const requested = await manager.findOne(Refund, { where: { id: refundId } });
      if (!requested)
        throw new NotFoundException(
          biBody('Refund not found', 'Ø·Ù„Ø¨ Ø§Ù„Ø§Ø³ØªØ±Ø¯Ø§Ø¯ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'),
        );
      await acquireTeacherFinancialLock(
        manager,
        await this.teacherIdForOrder(manager, requested.order_id),
      );
      const refund = await manager.findOne(Refund, {
        where: { id: refundId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!refund)
        throw new NotFoundException(biBody('Refund not found', 'طلب الاسترداد غير موجود'));
      if (refund.status === RefundStatus.SUCCEEDED) return refund;
      if (!providerVerified && refund.requested_by === adminId) {
        throw new ConflictException(
          biBody(
            'Refund requester cannot complete the same refund',
            'Refund requester cannot complete the same refund',
          ),
        );
      }
      if (
        ![RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING].includes(
          refund.status,
        )
      ) {
        throw new ConflictException(
          biBody(
            'Refund cannot be completed in its current state',
            'لا يمكن إتمام الاسترداد في حالته الحالية',
          ),
        );
      }
      if (refund.channel === PaymentChannel.GATEWAY && !providerVerified) {
        throw new ConflictException(
          biBody(
            'Gateway refund completion requires verified provider confirmation',
            'إتمام استرداد البوابة يتطلب تأكيداً موثقاً من المزود',
          ),
        );
      }
      const order = await manager.findOne(Order, {
        where: { id: refund.order_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
      const remaining = order.final_amount_minor - order.refunded_amount_minor;
      if (refund.amount_minor > remaining) {
        throw new BadRequestException(refundAmountExceedsRemaining());
      }

      refund.status = RefundStatus.SUCCEEDED;
      refund.external_method = dto.external_method;
      refund.external_reference = dto.external_reference;
      refund.completed_by = adminId;
      refund.completed_at = new Date();
      if (dto.note?.trim()) refund.internal_note = dto.note.trim();
      await manager.save(Refund, refund);

      const refundedBefore = order.refunded_amount_minor;
      order.refunded_amount_minor += refund.amount_minor;
      order.status =
        order.refunded_amount_minor === order.final_amount_minor
          ? OrderStatus.REFUNDED
          : OrderStatus.PARTIALLY_REFUNDED;
      await manager.save(Order, order);
      if (order.payment_id && order.status === OrderStatus.REFUNDED) {
        await manager.update(Payment, order.payment_id, { status: PaymentStatus.REFUNDED });
      }
      if (order.status === OrderStatus.REFUNDED) {
        await this.revokeAccess(manager, order, refund);
      }
      await this.reverseLedger(manager, order, refund, refundedBefore);
      await this.notification(manager, order, refund);
      await writeDomainEvent(manager, 'refund.completed', `refund:${refund.id}:completed`, {
        refund_id: refund.id,
        order_id: order.id,
        amount_minor: refund.amount_minor,
        currency: refund.currency,
      });
      if (order.status === OrderStatus.REFUNDED) {
        await writeDomainEvent(
          manager,
          'entitlement.revoked',
          `refund:${refund.id}:entitlement-revoked`,
          {
            refund_id: refund.id,
            order_id: order.id,
          },
        );
      }
      await this.audit(manager, adminId, 'refund_completed', refund, {
        order_id: order.id,
        external_method: dto.external_method,
        external_reference: dto.external_reference,
        entitlement_policy:
          order.status === OrderStatus.REFUNDED
            ? 'revoked_on_full_refund'
            : 'retained_on_partial_refund',
      });
      return refund;
    };
    if (transactionManager) return execute(transactionManager);
    return retryTransaction(this.dataSource, execute);
  }

  public async completeProviderNotification(
    paymentId: string,
    externalReference: string,
    amountMinor: number,
    currency: string,
  ): Promise<Refund> {
    return this.completeProviderNotificationLocked(
      paymentId,
      externalReference,
      amountMinor,
      currency,
    );
  }

  private async completeProviderNotificationLocked(
    paymentId: string,
    externalReference: string,
    amountMinor: number,
    currency: string,
    transactionManager?: EntityManager,
  ): Promise<Refund> {
    const prepare = async (manager: EntityManager) => {
      const paymentContext = await manager.findOne(Payment, { where: { id: paymentId } });
      if (!paymentContext?.order_id) {
        throw new NotFoundException(
          biBody('Canonical payment order not found', 'Canonical payment order not found'),
        );
      }
      await acquireTeacherFinancialLock(
        manager,
        await this.teacherIdForOrder(manager, paymentContext.order_id),
      );
      const payment = await manager.findOne(Payment, {
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment?.order_id) {
        throw new NotFoundException(
          biBody('Canonical payment order not found', 'Canonical payment order not found'),
        );
      }
      const order = await manager.findOne(Order, {
        where: { id: payment.order_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(biBody('Order not found', 'Order not found'));
      const remaining = order.final_amount_minor - order.refunded_amount_minor;
      if (
        order.status !== OrderStatus.PAID ||
        amountMinor !== remaining ||
        currency.toUpperCase() !== order.currency.toUpperCase()
      ) {
        throw new BadRequestException(
          biBody(
            'Provider refund does not match the remaining paid order amount and currency',
            'Provider refund does not match the remaining paid order amount and currency',
          ),
        );
      }
      const refund = await manager.findOne(Refund, {
        where: {
          order_id: order.id,
          status: In([RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING]),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (refund) {
        if (
          refund.amount_minor !== amountMinor ||
          refund.currency.toUpperCase() !== currency.toUpperCase()
        ) {
          throw new BadRequestException(
            biBody(
              'Provider refund does not match the pending refund',
              'Provider refund does not match the pending refund',
            ),
          );
        }
        refund.status = RefundStatus.PROCESSING;
        refund.external_method = payment.provider;
        refund.external_reference = externalReference;
        await manager.save(Refund, refund);
        return { refund, provider: payment.provider ?? 'gateway' };
      }
      const created = await manager.save(
        Refund,
        manager.create(Refund, {
          order_id: order.id,
          payment_id: payment.id,
          channel: PaymentChannel.GATEWAY,
          amount_minor: amountMinor,
          currency: order.currency,
          status: RefundStatus.PROCESSING,
          reason_code: 'provider_refund',
          reason: 'Provider reported a completed refund',
          internal_note: null,
          external_method: payment.provider,
          external_reference: externalReference,
          proof_file_key: null,
          requested_by: order.student_id,
          approved_by: null,
          completed_by: null,
          completed_at: null,
          metadata: { provider_notification: true },
        }),
      );
      return { refund: created, provider: payment.provider ?? 'gateway' };
    };
    const prepared = transactionManager
      ? await prepare(transactionManager)
      : await retryTransaction(this.dataSource, prepare);
    return this.complete(
      prepared.refund.id,
      { external_method: prepared.provider, external_reference: externalReference },
      prepared.refund.requested_by,
      true,
      transactionManager,
    );
  }

  /** Used by the webhook state machine to keep payment and refund effects atomic. */
  public async completeProviderNotificationInTransaction(
    manager: EntityManager,
    paymentId: string,
    externalReference: string,
    amountMinor: number,
    currency: string,
  ): Promise<Refund> {
    return this.completeProviderNotificationLocked(
      paymentId,
      externalReference,
      amountMinor,
      currency,
      manager,
    );
  }

  public async list(filter: RefundFilterDto): Promise<{ data: Refund[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const query = this.refunds
      .createQueryBuilder('refund')
      .leftJoinAndMapOne('refund.order', Order, 'order', 'order.id = refund.order_id');
    if (filter.status) query.where('refund.status = :status', { status: filter.status });
    if (filter.teacher_id)
      query.andWhere('order.teacher_id = :teacherId', { teacherId: filter.teacher_id });
    const [data, total] = await query
      .orderBy('refund.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Withdraw everything a fully refunded order paid for. Called ONLY once the
   * refund has reached SUCCEEDED and the order has become fully `REFUNDED`,
   * from inside that same transaction — so access (and, since DEF-019, the
   * course certificate that access justified) is never withdrawn on a merely
   * *requested* refund, and never survives a completed one.
   */
  private async revokeAccess(manager: EntityManager, order: Order, refund: Refund): Promise<void> {
    const reason = `refund:${refund.reason_code}`;
    await this.lessonSessions.refundForOrder(manager, order.id);
    await manager.update(
      Entitlement,
      { order_id: order.id, status: EntitlementStatus.ACTIVE },
      {
        status: EntitlementStatus.REVOKED,
        revoked_at: new Date(),
        revocation_reason: reason,
      },
    );
    if (!order.payment_id) return;
    const revokedAt = new Date();
    await manager.update(
      LessonPurchase,
      { payment_id: order.payment_id },
      { revoked_at: revokedAt, revocation_reason: reason },
    );
    // Read the course purchases BEFORE revoking them: the certificate
    // revocation below needs the (student, course) pairs this order granted.
    const coursePurchases = await manager.find(PackagePurchase, {
      where: { payment_id: order.payment_id },
    });
    await manager.update(
      PackagePurchase,
      { payment_id: order.payment_id },
      { revoked_at: revokedAt, revocation_reason: reason },
    );
    await this.revokeCourseCertificates(manager, order, refund, coursePurchases, reason);
    await manager.update(
      BookPurchase,
      { payment_id: order.payment_id },
      { revoked_at: revokedAt, revocation_reason: reason },
    );
    if (order.item_type === ItemType.LESSON) {
      await manager.decrement(Lesson, { id: order.item_id }, 'students_count', 1);
    } else if (order.item_type === ItemType.LESSON_SESSION) {
      // Individual appointment counts are derived from bookings, not students_count.
    } else if (order.item_type === ItemType.BOOK) {
      await manager.decrement(Book, { id: order.item_id }, 'purchase_count', 1);
    } else {
      const lessons = await manager.find(LessonPurchase, {
        where: { payment_id: order.payment_id },
      });
      for (const lesson of lessons) {
        await manager.decrement(Lesson, { id: lesson.lesson_id }, 'students_count', 1);
      }
    }
  }

  /**
   * DEF-019: a course certificate is valid only while the student holds a
   * valid, non-revoked purchase for that course, so a completed FULL refund
   * revokes it. Runs after the purchase rows above are already revoked in this
   * same transaction, which closes the race with concurrent auto-issuance:
   * whichever transaction takes the `package_purchases` row lock first wins,
   * and the issuance path re-reads the committed revocation and refuses.
   *
   * Idempotent — an already-revoked certificate is left alone, so replaying a
   * refund completion produces no second revocation record or event.
   */
  private async revokeCourseCertificates(
    manager: EntityManager,
    order: Order,
    refund: Refund,
    coursePurchases: PackagePurchase[],
    reason: string,
  ): Promise<void> {
    for (const purchase of coursePurchases) {
      const revoked = await this.certificateEligibility.revokeForWithdrawnAccess(manager, {
        studentId: purchase.student_id,
        packageId: purchase.package_id,
        reason,
        actorId: refund.completed_by ?? null,
        context: {
          source: 'refund',
          refund_id: refund.id,
          order_id: order.id,
          package_purchase_id: purchase.id,
          ...(order.payment_id ? { payment_id: order.payment_id } : {}),
        },
      });
      if (!revoked) continue;
      await writeDomainEvent(
        manager,
        'certificate.revoked',
        `refund:${refund.id}:certificate-revoked:${revoked.id}`,
        {
          certificate_id: revoked.id,
          certificate_number: revoked.certificate_number,
          student_id: purchase.student_id,
          package_id: purchase.package_id,
          refund_id: refund.id,
          order_id: order.id,
        },
      );
      await manager.insert(PaymentAuditLog, {
        actor_id: refund.completed_by,
        action: 'certificate_revoked_on_full_refund',
        resource_type: 'certificate',
        resource_id: revoked.id,
        details: {
          refund_id: refund.id,
          order_id: order.id,
          student_id: purchase.student_id,
          package_id: purchase.package_id,
          certificate_number: revoked.certificate_number,
        } as never,
        ip_address: null,
      });
    }
  }

  private async reverseLedger(
    manager: EntityManager,
    order: Order,
    refund: Refund,
    refundedBefore: number,
  ): Promise<void> {
    const common = {
      order_id: order.id,
      payment_id: order.payment_id,
      teacher_id: order.teacher_id,
      currency: order.currency,
      source_channel: order.payment_channel,
      collection_party: order.collection_party,
      status: LedgerEntryStatus.POSTED,
      available_at: new Date(),
      settlement_id: null,
      metadata: { refund_id: refund.id },
    };
    const originalEarning = await manager.findOne(FinancialLedgerEntry, {
      where: { reference: `order:${order.id}:teacher-earning` },
      lock: { mode: 'pessimistic_write' },
    });
    const releasedEarning = originalEarning
      ? await manager.findOne(FinancialLedgerEntry, {
          where: { reference: `release:${originalEarning.id}:available` },
          lock: { mode: 'pessimistic_write' },
        })
      : null;
    const payableAccount =
      releasedEarning || originalEarning?.account === 'teacher_payable_available'
        ? 'teacher_payable_available'
        : 'teacher_payable';
    // Compare cumulative allocations before and after this refund. This makes
    // partial refunds deterministic and guarantees that a final refund exactly
    // reverses the original commission and teacher earning despite rounding.
    const cumulativeCommission = (refunded: number): number =>
      Math.floor((order.platform_commission_minor * refunded) / order.final_amount_minor);
    const commissionReversal =
      cumulativeCommission(refundedBefore + refund.amount_minor) -
      cumulativeCommission(refundedBefore);
    const teacherReversal = refund.amount_minor - commissionReversal;
    let entries: Array<Partial<FinancialLedgerEntry>>;
    if (order.collection_party === CollectionParty.PLATFORM) {
      entries = [
        {
          ...common,
          account: 'platform_revenue',
          entry_type: LedgerEntryType.COMMISSION_REVERSAL,
          amount_minor: commissionReversal,
          direction: LedgerDirection.DEBIT,
          reference: `refund:${refund.id}:commission-reversal`,
        },
        {
          ...common,
          account: payableAccount,
          entry_type: LedgerEntryType.TEACHER_EARNING_REVERSAL,
          amount_minor: teacherReversal,
          direction: LedgerDirection.DEBIT,
          reference: `refund:${refund.id}:teacher-reversal`,
        },
        {
          ...common,
          account: 'platform_cash',
          entry_type: LedgerEntryType.REFUND,
          amount_minor: refund.amount_minor,
          direction: LedgerDirection.CREDIT,
          reference: `refund:${refund.id}:cash`,
        },
      ];
    } else if (order.collection_party !== CollectionParty.UNKNOWN) {
      entries = [
        {
          ...common,
          account: 'teacher_collected_earnings',
          entry_type: LedgerEntryType.TEACHER_EARNING_REVERSAL,
          amount_minor: teacherReversal,
          direction: LedgerDirection.DEBIT,
          reference: `refund:${refund.id}:teacher-collected-reversal`,
        },
        {
          ...common,
          account: 'platform_receivable',
          entry_type: LedgerEntryType.COMMISSION_REVERSAL,
          amount_minor: commissionReversal,
          direction: LedgerDirection.DEBIT,
          reference: `refund:${refund.id}:receivable-reversal`,
        },
        {
          ...common,
          account: 'teacher_collected_cash',
          entry_type: LedgerEntryType.REFUND,
          amount_minor: refund.amount_minor,
          direction: LedgerDirection.CREDIT,
          reference: `refund:${refund.id}:teacher-cash`,
        },
      ];
    } else {
      entries = [
        {
          ...common,
          account: 'unallocated_sale_suspense',
          entry_type: LedgerEntryType.MANUAL_ADJUSTMENT,
          amount_minor: refund.amount_minor,
          direction: LedgerDirection.DEBIT,
          reference: `refund:${refund.id}:unknown-collection-debit`,
        },
        {
          ...common,
          account: 'collection_suspense',
          entry_type: LedgerEntryType.REFUND,
          amount_minor: refund.amount_minor,
          direction: LedgerDirection.CREDIT,
          reference: `refund:${refund.id}:unknown-collection-credit`,
        },
      ];
    }
    for (const entry of entries) {
      if ((entry.amount_minor ?? 0) === 0) continue;
      await manager
        .createQueryBuilder()
        .insert()
        .into(FinancialLedgerEntry)
        .values(entry as never)
        .orIgnore()
        .execute();
    }
  }

  private async teacherIdForOrder(manager: EntityManager, orderId: string): Promise<string | null> {
    const order = await manager.findOne(Order, { where: { id: orderId } });
    return order?.teacher_id ?? null;
  }

  private async notification(manager: EntityManager, order: Order, refund: Refund): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values({
        dedupe_key: `refund:${refund.id}:student`,
        origin: NotificationOrigin.SYSTEM,
        source_event: 'refund_completed',
        user_id: order.student_id,
        type: NotificationType.PURCHASE,
        title: 'Refund completed',
        message: `Refund for order ${order.order_number} has been completed.`,
        data: { refund_id: refund.id, order_id: order.id, amount_minor: refund.amount_minor },
        is_read: false,
        sent_at: new Date(),
        read_at: null,
        sms_sent: false,
        sms_to: null,
        status: NotificationStatus.SENT,
        attempts: 0,
        error_message: null,
        delivered_at: null,
      })
      .orIgnore()
      .execute();
    if (order.teacher_id) {
      await manager
        .createQueryBuilder()
        .insert()
        .into(Notification)
        .values({
          dedupe_key: `refund:${refund.id}:teacher`,
          origin: NotificationOrigin.SYSTEM,
          source_event: 'refund_completed',
          user_id: order.teacher_id,
          type: NotificationType.PURCHASE,
          title: 'Sale refunded',
          message: `Order ${order.order_number} was refunded and the related earning was reversed.`,
          data: {
            refund_id: refund.id,
            order_id: order.id,
            amount_minor: refund.amount_minor,
            currency: refund.currency,
          },
          is_read: false,
          sent_at: new Date(),
          read_at: null,
          sms_sent: false,
          sms_to: null,
          status: NotificationStatus.SENT,
          attempts: 0,
          error_message: null,
          delivered_at: null,
        } as never)
        .orIgnore()
        .execute();
    }
  }

  private async audit(
    manager: EntityManager,
    actorId: string,
    action: string,
    refund: Refund,
    details: Record<string, unknown>,
  ): Promise<void> {
    await writePaymentAudit(manager, {
      actorId,
      action,
      resourceType: 'refund',
      resourceId: refund.id,
      details,
    });
  }
}
