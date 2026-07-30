import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';

import {
  AttendanceCode,
  AttendanceCodeAudit,
  AttendanceCodeAuditAction,
  AttendanceCodeStatus,
} from '../../attendance-codes/entities';
import { Book } from '../../books/entities/book.entity';
import { BookPurchase } from '../../books/entities/book-purchase.entity';
import { computeAccessExpiresAt } from '../../common/utils/lesson-access.util';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationStatus } from '../../notifications/entities/notification-status.enum';
import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
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
  ManualPaymentSubmission,
  ManualPaymentSubmissionStatus,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentAuditLog,
  PaymentChannel,
  PaymentDomainEvent,
  PaymentStatus,
} from '../entities';
import { fromMinorUnits } from '../money.util';

export interface FinalizePaymentInput {
  orderId: string;
  paymentId?: string;
  sourceReference: string;
  actorId?: string | null;
  activationCodeId?: string;
  manualSubmissionId?: string;
  verifiedAmountMinor?: number;
  verifiedCurrency?: string;
  /** Only a signed/reconciled gateway fact may reopen a locally expired order. */
  verifiedOccurredAt?: Date;
}

export interface FinalizationResult {
  order: Order;
  payment: Payment;
  entitlement: Entitlement;
  alreadyFinalized: boolean;
}

@Injectable()
export class PaymentFinalizationService {
  private readonly logger = new Logger(PaymentFinalizationService.name);
  private readonly refundHoldDays: number;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.refundHoldDays = Math.max(
      0,
      Number.parseInt(config.get<string>('TEACHER_EARNING_HOLD_DAYS') ?? '7', 10),
    );
  }

  public async finalizeSuccessfulPayment(
    input: FinalizePaymentInput,
    manager?: EntityManager,
  ): Promise<FinalizationResult> {
    if (manager) return this.finalizeWithinTransaction(manager, input);
    return retryTransaction(this.dataSource, (transactionManager) =>
      this.finalizeWithinTransaction(transactionManager, input),
    );
  }

  private async finalizeWithinTransaction(
    manager: EntityManager,
    input: FinalizePaymentInput,
  ): Promise<FinalizationResult> {
    const order = await manager.findOne(Order, {
      where: { id: input.orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    const paymentId = input.paymentId ?? order.payment_id;
    if (!paymentId || (order.payment_id && paymentId !== order.payment_id)) {
      throw new UnprocessableEntityException(
        biBody('Payment does not belong to this order', 'عملية الدفع لا تخص هذا الطلب'),
      );
    }
    const payment = await manager.findOne(Payment, {
      where: { id: paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !payment ||
      payment.order_id !== order.id ||
      payment.user_id !== order.student_id ||
      payment.item_type !== order.item_type ||
      payment.item_id !== order.item_id
    ) {
      throw new UnprocessableEntityException(
        biBody('Payment and order details do not match', 'بيانات الدفع والطلب غير متطابقة'),
      );
    }

    if (order.status === OrderStatus.PAID && payment.status === PaymentStatus.COMPLETED) {
      const existing = await manager.findOne(Entitlement, { where: { order_id: order.id } });
      if (!existing) {
        throw new UnprocessableEntityException(
          biBody(
            'Paid order is missing its entitlement; reconciliation is required',
            'الطلب المدفوع يفتقد صلاحية الوصول ويتطلب تسوية',
          ),
        );
      }
      return { order, payment, entitlement: existing, alreadyFinalized: true };
    }

    const lateGatewaySuccess =
      order.status === OrderStatus.EXPIRED &&
      order.payment_channel === PaymentChannel.GATEWAY &&
      input.verifiedAmountMinor !== undefined &&
      input.verifiedCurrency !== undefined &&
      input.verifiedOccurredAt instanceof Date &&
      Number.isFinite(input.verifiedOccurredAt.getTime());
    if (
      [OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.PARTIALLY_REFUNDED].includes(
        order.status,
      ) ||
      (order.status === OrderStatus.EXPIRED && !lateGatewaySuccess)
    ) {
      throw new UnprocessableEntityException(
        biBody(
          'Order cannot be finalized in its current state',
          'لا يمكن إتمام الطلب في حالته الحالية',
        ),
      );
    }

    this.assertVerifiedFinancials(order, payment, input);
    await this.validateAndConsumeSource(manager, order, input);

    payment.status = PaymentStatus.COMPLETED;
    payment.completed_at = new Date();
    payment.amount_minor = order.final_amount_minor;
    payment.currency = order.currency;
    payment.channel = order.payment_channel;
    payment.provider_reference = input.sourceReference;
    if (order.payment_channel === PaymentChannel.GATEWAY) {
      payment.paymob_transaction_id = input.sourceReference;
    }
    await manager.save(Payment, payment);

    order.status = OrderStatus.PAID;
    order.paid_at = new Date();
    order.payment_id = payment.id;
    await manager.save(Order, order);

    const entitlement = await this.grantEntitlement(manager, order, payment);
    await this.postLedger(manager, order, payment, input.sourceReference);
    await this.writeNotifications(manager, order);
    await this.writeDomainEvents(manager, order, payment, entitlement);
    await manager.insert(PaymentAuditLog, {
      actor_id: input.actorId ?? order.student_id,
      action: 'payment_finalized',
      resource_type: 'order',
      resource_id: order.id,
      details: {
        order_number: order.order_number,
        channel: order.payment_channel,
        payment_id: payment.id,
        source_reference: input.sourceReference,
        amount_minor: order.final_amount_minor,
        currency: order.currency,
      },
      ip_address: null,
    });

    this.logger.log(`Finalized order ${order.order_number} through ${order.payment_channel}`);
    return { order, payment, entitlement, alreadyFinalized: false };
  }

  private assertVerifiedFinancials(
    order: Order,
    payment: Payment,
    input: FinalizePaymentInput,
  ): void {
    if (payment.amount_minor !== null && payment.amount_minor !== order.final_amount_minor) {
      throw new UnprocessableEntityException(
        biBody('Payment amount does not match order total', 'قيمة الدفع لا تطابق إجمالي الطلب'),
      );
    }
    if (payment.currency.toUpperCase() !== order.currency.toUpperCase()) {
      throw new UnprocessableEntityException(
        biBody('Payment currency does not match order currency', 'عملة الدفع لا تطابق عملة الطلب'),
      );
    }
    if (
      input.verifiedAmountMinor !== undefined &&
      input.verifiedAmountMinor !== order.final_amount_minor
    ) {
      throw new UnprocessableEntityException(
        biBody('Captured amount does not match order total', 'المبلغ المحصل لا يطابق إجمالي الطلب'),
      );
    }
    if (
      input.verifiedCurrency !== undefined &&
      input.verifiedCurrency.toUpperCase() !== order.currency.toUpperCase()
    ) {
      throw new UnprocessableEntityException(
        biBody(
          'Captured currency does not match order currency',
          'العملة المحصلة لا تطابق عملة الطلب',
        ),
      );
    }
    if (
      order.payment_channel === PaymentChannel.GATEWAY &&
      (input.verifiedAmountMinor === undefined || input.verifiedCurrency === undefined)
    ) {
      throw new UnprocessableEntityException(
        biBody(
          'Verified gateway financial data is required',
          'بيانات الدفع الإلكتروني الموثقة مطلوبة',
        ),
      );
    }
  }

  private async validateAndConsumeSource(
    manager: EntityManager,
    order: Order,
    input: FinalizePaymentInput,
  ): Promise<void> {
    if (order.payment_channel === PaymentChannel.ACTIVATION_CODE) {
      const codeId = input.activationCodeId ?? order.activation_code_id;
      if (!codeId || codeId !== order.activation_code_id) {
        throw new UnprocessableEntityException(
          biBody('Activation code does not match this order', 'رمز التفعيل لا يطابق هذا الطلب'),
        );
      }
      const code = await manager.findOne(AttendanceCode, {
        where: { id: codeId },
        lock: { mode: 'pessimistic_write' },
      });
      const now = new Date();
      if (
        !code ||
        code.item_id !== order.item_id ||
        code.is_used ||
        !code.is_active ||
        code.status === AttendanceCodeStatus.REDEEMED ||
        code.status === AttendanceCodeStatus.REVOKED ||
        code.expires_at <= now ||
        (code.valid_from !== null && code.valid_from > now) ||
        code.redemption_count >= code.maximum_redemptions ||
        (code.assigned_student_id !== null && code.assigned_student_id !== order.student_id)
      ) {
        throw new UnprocessableEntityException(
          biBody('Activation code is no longer redeemable', 'رمز التفعيل لم يعد قابلاً للاستخدام'),
        );
      }
      code.is_used = true;
      code.status = AttendanceCodeStatus.REDEEMED;
      code.used_by = order.student_id;
      code.used_at = now;
      code.redemption_count += 1;
      code.redeemed_order_id = order.id;
      await manager.save(AttendanceCode, code);
      await manager.insert(AttendanceCodeAudit, {
        code_id: code.id,
        batch_id: code.batch_id,
        action: AttendanceCodeAuditAction.REDEEMED,
        actor_id: order.student_id,
        metadata: {
          masked_code: this.maskCode(code.code),
          order_id: order.id,
          order_number: order.order_number,
        },
      });
      return;
    }

    if (order.payment_channel === PaymentChannel.MANUAL) {
      if (!input.manualSubmissionId) {
        throw new UnprocessableEntityException(
          biBody('Manual payment submission is required', 'إثبات الدفع اليدوي مطلوب'),
        );
      }
      const submission = await manager.findOne(ManualPaymentSubmission, {
        where: { id: input.manualSubmissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !submission ||
        submission.order_id !== order.id ||
        submission.student_id !== order.student_id ||
        submission.claimed_amount_minor !== order.final_amount_minor ||
        submission.currency.toUpperCase() !== order.currency.toUpperCase() ||
        ![
          ManualPaymentSubmissionStatus.SUBMITTED,
          ManualPaymentSubmissionStatus.UNDER_REVIEW,
        ].includes(submission.status)
      ) {
        throw new UnprocessableEntityException(
          biBody(
            'Manual payment submission does not match this order',
            'إثبات الدفع اليدوي لا يطابق هذا الطلب',
          ),
        );
      }
      submission.status = ManualPaymentSubmissionStatus.APPROVED;
      submission.reviewed_by = input.actorId ?? null;
      submission.reviewed_at = new Date();
      await manager.save(ManualPaymentSubmission, submission);
    }
  }

  private async grantEntitlement(
    manager: EntityManager,
    order: Order,
    payment: Payment,
  ): Promise<Entitlement> {
    const existing = await manager.findOne(Entitlement, { where: { order_id: order.id } });
    if (existing) return existing;
    const grantedAt = new Date();
    const duration = Number(order.metadata?.['access_duration_days']);
    const expiresAt =
      order.item_type === ItemType.LESSON && Number.isFinite(duration) && duration > 0
        ? computeAccessExpiresAt(grantedAt, duration)
        : null;
    const entitlement = await manager.save(
      Entitlement,
      manager.create(Entitlement, {
        student_id: order.student_id,
        item_type: order.item_type,
        item_id: order.item_id,
        order_id: order.id,
        payment_id: payment.id,
        source_channel: order.payment_channel,
        status: EntitlementStatus.ACTIVE,
        granted_at: grantedAt,
        starts_at: grantedAt,
        expires_at: expiresAt,
        revoked_at: null,
        revocation_reason: null,
      }),
    );
    await this.writeCompatibilityPurchase(manager, order, payment, grantedAt, expiresAt);
    return entitlement;
  }

  private async writeCompatibilityPurchase(
    manager: EntityManager,
    order: Order,
    payment: Payment,
    grantedAt: Date,
    expiresAt: Date | null,
  ): Promise<void> {
    if (order.item_type === ItemType.LESSON) {
      const lesson = await manager.findOne(Lesson, { where: { id: order.item_id } });
      if (!lesson) throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
      const effectiveExpiry =
        expiresAt ?? computeAccessExpiresAt(grantedAt, lesson.available_for_days || 7);
      await manager.insert(LessonPurchase, {
        student_id: order.student_id,
        lesson_id: order.item_id,
        payment_id: payment.id,
        price_paid: fromMinorUnits(order.final_amount_minor),
        access_granted_at: grantedAt,
        access_expires_at: effectiveExpiry,
        days_extended: 0,
        revoked_at: null,
        revocation_reason: null,
      });
      await manager.increment(Lesson, { id: order.item_id }, 'students_count', 1);
      return;
    }
    if (order.item_type === ItemType.PACKAGE) {
      const pkg = await manager.findOne(LessonPackage, {
        where: { id: order.item_id },
        relations: ['items', 'items.lesson'],
      });
      if (!pkg) throw new NotFoundException(biBody('Package not found', 'الباقة غير موجودة'));
      await manager.insert(PackagePurchase, {
        student_id: order.student_id,
        package_id: order.item_id,
        payment_id: payment.id,
        price_paid: fromMinorUnits(order.final_amount_minor),
        purchased_at: grantedAt,
        revoked_at: null,
        revocation_reason: null,
      });
      for (const item of pkg.items) {
        const lessonExpiry = computeAccessExpiresAt(grantedAt, item.lesson.available_for_days || 7);
        await manager.insert(LessonPurchase, {
          student_id: order.student_id,
          lesson_id: item.lesson.id,
          payment_id: payment.id,
          price_paid: 0,
          access_granted_at: grantedAt,
          access_expires_at: lessonExpiry,
          days_extended: 0,
          revoked_at: null,
          revocation_reason: null,
        });
        await manager.increment(Lesson, { id: item.lesson.id }, 'students_count', 1);
      }
      return;
    }
    await manager.insert(BookPurchase, {
      student_id: order.student_id,
      book_id: order.item_id,
      payment_id: payment.id,
      price_paid: fromMinorUnits(order.final_amount_minor),
      revoked_at: null,
      revocation_reason: null,
    });
    await manager.increment(Book, { id: order.item_id }, 'purchase_count', 1);
  }

  private async postLedger(
    manager: EntityManager,
    order: Order,
    payment: Payment,
    sourceReference: string,
  ): Promise<void> {
    const isPlatformCollected = order.collection_party === CollectionParty.PLATFORM;
    const collectionKnown = order.collection_party !== CollectionParty.UNKNOWN;
    const common = {
      order_id: order.id,
      payment_id: payment.id,
      teacher_id: order.teacher_id,
      currency: order.currency,
      source_channel: order.payment_channel,
      collection_party: order.collection_party,
      status: LedgerEntryStatus.POSTED,
      settlement_id: null,
      metadata: { source_reference: sourceReference },
    };
    const entries: Array<Partial<FinancialLedgerEntry>> = [];
    if (isPlatformCollected) {
      entries.push({
        ...common,
        account: 'platform_cash',
        entry_type: LedgerEntryType.PLATFORM_COLLECTED_SALE,
        amount_minor: order.final_amount_minor,
        direction: LedgerDirection.DEBIT,
        available_at: null,
        reference: `order:${order.id}:platform-cash`,
      });
      entries.push({
        ...common,
        account: 'platform_revenue',
        entry_type: LedgerEntryType.PLATFORM_COMMISSION,
        amount_minor: order.platform_commission_minor,
        direction: LedgerDirection.CREDIT,
        available_at: null,
        reference: `order:${order.id}:platform-commission`,
      });
      const availableAt =
        this.refundHoldDays > 0
          ? new Date(Date.now() + this.refundHoldDays * 86_400_000)
          : new Date();
      entries.push({
        ...common,
        account: this.refundHoldDays > 0 ? 'teacher_payable' : 'teacher_payable_available',
        entry_type:
          this.refundHoldDays > 0
            ? LedgerEntryType.TEACHER_EARNING_PENDING
            : LedgerEntryType.TEACHER_EARNING_AVAILABLE,
        amount_minor: order.teacher_earning_minor,
        direction: LedgerDirection.CREDIT,
        available_at: availableAt,
        reference: `order:${order.id}:teacher-earning`,
      });
    } else if (collectionKnown) {
      entries.push({
        ...common,
        account: 'teacher_collected_cash',
        entry_type: LedgerEntryType.TEACHER_COLLECTED_SALE,
        amount_minor: order.final_amount_minor,
        direction: LedgerDirection.DEBIT,
        available_at: null,
        reference: `order:${order.id}:teacher-collected`,
      });
      entries.push({
        ...common,
        account: 'teacher_collected_earnings',
        entry_type: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
        amount_minor: order.teacher_earning_minor,
        direction: LedgerDirection.CREDIT,
        available_at: new Date(),
        reference: `order:${order.id}:teacher-collected-earning`,
      });
      entries.push({
        ...common,
        account: 'platform_receivable',
        entry_type: LedgerEntryType.PLATFORM_RECEIVABLE,
        amount_minor: order.platform_commission_minor,
        direction: LedgerDirection.CREDIT,
        available_at: new Date(),
        reference: `order:${order.id}:platform-receivable`,
      });
    } else {
      // Imported legacy codes may not identify who collected the cash. Keep
      // these sales balanced in suspense and out of teacher settlements until
      // finance resolves the collector explicitly.
      entries.push(
        {
          ...common,
          account: 'collection_suspense',
          entry_type:
            order.payment_channel === PaymentChannel.ACTIVATION_CODE
              ? LedgerEntryType.ACTIVATION_CODE_SALE
              : LedgerEntryType.STUDENT_PAYMENT,
          amount_minor: order.final_amount_minor,
          direction: LedgerDirection.DEBIT,
          available_at: null,
          reference: `order:${order.id}:unknown-collection-debit`,
        },
        {
          ...common,
          account: 'unallocated_sale_suspense',
          entry_type: LedgerEntryType.MANUAL_ADJUSTMENT,
          amount_minor: order.final_amount_minor,
          direction: LedgerDirection.CREDIT,
          available_at: null,
          reference: `order:${order.id}:unknown-collection-credit`,
        },
      );
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

  private async writeNotifications(manager: EntityManager, order: Order): Promise<void> {
    const notifications: Array<Partial<Notification>> = [
      {
        dedupe_key: `order:${order.id}:student-paid`,
        user_id: order.student_id,
        type: NotificationType.PURCHASE,
        title: 'Payment approved',
        message: `Your order ${order.order_number} is paid and access is ready.`,
        data: { order_id: order.id, item_type: order.item_type, item_id: order.item_id },
        is_read: false,
        sent_at: new Date(),
        read_at: null,
        sms_sent: false,
        sms_to: null,
        status: NotificationStatus.SENT,
        attempts: 0,
        error_message: null,
        delivered_at: null,
      },
    ];
    if (order.teacher_id) {
      notifications.push({
        dedupe_key: `order:${order.id}:teacher-sale`,
        user_id: order.teacher_id,
        type: NotificationType.PURCHASE,
        title: 'New product sale',
        message: `${order.product_title_snapshot} was purchased through ${order.payment_channel}.`,
        data: {
          order_id: order.id,
          channel: order.payment_channel,
          teacher_earning_minor: order.teacher_earning_minor,
          currency: order.currency,
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
      });
    }
    for (const notification of notifications) {
      await manager
        .createQueryBuilder()
        .insert()
        .into(Notification)
        .values(notification as never)
        .orIgnore()
        .execute();
    }
  }

  private async writeDomainEvents(
    manager: EntityManager,
    order: Order,
    payment: Payment,
    entitlement: Entitlement,
  ): Promise<void> {
    const events: Array<{ name: string; suffix: string; payload: Record<string, unknown> }> = [
      {
        name: 'payment.succeeded',
        suffix: 'payment-succeeded',
        payload: { order_id: order.id, payment_id: payment.id, channel: order.payment_channel },
      },
      {
        name: 'entitlement.granted',
        suffix: 'entitlement-granted',
        payload: {
          order_id: order.id,
          entitlement_id: entitlement.id,
          student_id: order.student_id,
        },
      },
      {
        name: 'teacher_earning.created',
        suffix: 'teacher-earning',
        payload: {
          order_id: order.id,
          teacher_id: order.teacher_id,
          amount_minor: order.teacher_earning_minor,
          currency: order.currency,
        },
      },
    ];
    if (order.payment_channel === PaymentChannel.ACTIVATION_CODE) {
      events.push({
        name: 'activation_code.redeemed',
        suffix: 'code-redeemed',
        payload: { order_id: order.id, activation_code_id: order.activation_code_id },
      });
    }
    if (order.payment_channel === PaymentChannel.MANUAL) {
      events.push({
        name: 'manual_payment.approved',
        suffix: 'manual-approved',
        payload: { order_id: order.id, payment_id: payment.id },
      });
    }
    for (const event of events) {
      await manager
        .createQueryBuilder()
        .insert()
        .into(PaymentDomainEvent)
        .values({
          event_name: event.name,
          dedupe_key: `order:${order.id}:${event.suffix}`,
          payload: event.payload,
          published_at: null,
          attempts: 0,
          last_error: null,
        } as never)
        .orIgnore()
        .execute();
    }
  }

  private maskCode(code: string): string {
    if (code.length <= 4) return '****';
    return `${code.slice(0, 2)}${'*'.repeat(Math.max(4, code.length - 4))}${code.slice(-2)}`;
  }
}
