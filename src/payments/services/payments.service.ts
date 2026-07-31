import { forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, In, IsNull, MoreThan, Repository, SelectQueryBuilder } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { BookPurchase } from '../../books/entities/book-purchase.entity';
import { biBody } from '../../i18n/error-translator.util';
import { BillingDataDto } from '../dto/billing-data.dto';
import { PaymentFilterDto, type PaymentSortField } from '../dto/payment-filter.dto';
import { PurchaseBookPaymentDto } from '../dto/purchase-book.dto';
import { PurchaseLessonDto } from '../dto/purchase-lesson.dto';
import { PurchasePackageDto } from '../dto/purchase-package.dto';
import {
  ItemType,
  LessonPurchase,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentChannel,
  PaymentStatus,
} from '../entities';
import { EntitlementsService } from './entitlements.service';
import { OrdersService } from './orders.service';
import { PaymentFinalizationService } from './payment-finalization.service';
import { RefundsService } from './refunds.service';

export interface PaymentResponse {
  payment_id: string;
  payment_key: string;
  paymob_order_id: number;
  amount: number;
  discount_amount: number;
  final_amount: number;
  iframe_url: string;
}

/**
 * Verified facts extracted from a gateway webhook, used to guarantee financial
 * correctness before granting access: the amount actually captured (in cents)
 * and its currency must match what we expected to charge for this payment.
 */
export interface PaymentVerificationContext {
  amountCents: number;
  currency: string;
  transactionId?: string;
  /** Trusted provider timestamp used by the late-success recovery policy. */
  occurredAt?: Date;
}

const PAYMENT_SORT_COLUMN_BY_FIELD: Readonly<Record<PaymentSortField, string>> = {
  created_at: 'payment.created_at',
  amount: 'payment.amount',
  final_amount: 'payment.final_amount',
  status: 'payment.status',
};

export interface AccessCheckResult {
  has_access: boolean;
  expires_at?: Date;
  days_remaining?: number;
}

export interface RevenueStatistics {
  total_revenue: number;
  total_payments: number;
  total_discounts: number;
}

interface RevenueRawResult {
  total_revenue: string | null;
  total_payments: string | null;
  total_discounts: string | null;
}

// Type interfaces for teacher revenue raw query results
interface TeacherRevenueTotalRaw {
  total: string | null;
}

interface TeacherRevenuePeriodRaw {
  period: string;
  revenue: string;
  sales: string;
}

interface TeacherTopLessonsRaw {
  lesson_id: string;
  lesson_title: string;
  revenue: string;
  sales: string;
}

interface TeacherRevenueByLessonRaw {
  lesson_id: string;
  lesson_title: string;
  purchase_count: string;
  total_revenue: string;
  avg_price: string;
}

interface TeacherRevenueByPackageRaw {
  package_id: string;
  package_title: string;
  purchase_count: string;
  total_revenue: string;
  avg_price: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchasesRepository: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchasesRepository: Repository<PackagePurchase>,
    @InjectRepository(BookPurchase)
    private readonly bookPurchasesRepository: Repository<BookPurchase>,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => DiscountCodesService))
    private readonly discountCodesService: DiscountCodesService,
    private readonly ordersService: OrdersService,
    private readonly finalizer: PaymentFinalizationService,
    private readonly entitlementsService: EntitlementsService,
    private readonly refundsService: RefundsService,
  ) {}

  public async purchaseLesson(dto: PurchaseLessonDto, userId: string): Promise<PaymentResponse> {
    return this.purchaseThroughCanonicalOrder(
      ItemType.LESSON,
      dto.lesson_id,
      dto.discount_code,
      dto.idempotency_key,
      dto.billing_data,
      userId,
    );
  }

  /** Purchase a package through the configured payment gateway. */
  public async purchasePackage(dto: PurchasePackageDto, userId: string): Promise<PaymentResponse> {
    return this.purchaseThroughCanonicalOrder(
      ItemType.PACKAGE,
      dto.package_id,
      dto.discount_code,
      dto.idempotency_key,
      dto.billing_data,
      userId,
    );
  }

  /** Purchase a book through the configured payment gateway. */
  public async purchaseBook(dto: PurchaseBookPaymentDto, userId: string): Promise<PaymentResponse> {
    return this.purchaseThroughCanonicalOrder(
      ItemType.BOOK,
      dto.book_id,
      dto.discount_code,
      dto.idempotency_key,
      dto.billing_data,
      userId,
    );
  }

  private async purchaseThroughCanonicalOrder(
    itemType: ItemType,
    itemId: string,
    discountCode: string | undefined,
    idempotencyKey: string | undefined,
    billingData: BillingDataDto,
    userId: string,
  ): Promise<PaymentResponse> {
    const created = await this.ordersService.createOrder(
      {
        item_type: itemType,
        item_id: itemId,
        payment_channel: PaymentChannel.GATEWAY,
        ...(discountCode !== undefined ? { discount_code: discountCode } : {}),
        ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      },
      userId,
    );
    const checkout = await this.ordersService.startGatewayCheckout(created.order.id, userId, {
      billing_data: billingData,
    });
    return {
      payment_id: checkout.payment_id,
      payment_key: checkout.payment_id,
      paymob_order_id: 0,
      amount: created.order.original_amount_minor / 100,
      discount_amount: created.order.discount_amount_minor / 100,
      final_amount: created.order.final_amount_minor / 100,
      iframe_url: checkout.redirect_url,
    };
  }

  /**
   * Reopen an expired lesson at 50% price
   */
  public async reopenLesson(
    lessonId: string,
    userId: string,
    billingData: BillingDataDto,
  ): Promise<PaymentResponse> {
    const created = await this.ordersService.createReopenOrder(lessonId, userId);
    const checkout = await this.ordersService.startGatewayCheckout(created.order.id, userId, {
      billing_data: billingData,
    });
    return {
      payment_id: checkout.payment_id,
      payment_key: checkout.payment_id,
      paymob_order_id: 0,
      amount: created.order.original_amount_minor / 100,
      discount_amount: created.order.discount_amount_minor / 100,
      final_amount: created.order.final_amount_minor / 100,
      iframe_url: checkout.redirect_url,
    };
  }

  /**
   * Process successful payment - grant access.
   *
   * Financial-correctness guarantees (all enforced inside a single
   * pessimistically-locked transaction, so concurrent/duplicate webhooks are
   * serialized):
   * - Idempotent: a payment already COMPLETED is skipped (no double grant).
   * - Terminal-state safe: a REFUNDED/EXPIRED payment is never resurrected.
   * - Amount-tamper safe: the captured amount must equal the expected
   *   `final_amount` (to the cent) or access is refused (underpayment,
   *   partial capture, amount tampering).
   * - Currency-tamper safe: the captured currency must match EGP.
   */
  public async processSuccessfulPayment(
    paymentId: string,
    verification?: PaymentVerificationContext,
  ): Promise<void> {
    const payment = await this.paymentsRepository.findOne({
      where: { id: paymentId },
    });
    if (!payment?.order_id) {
      throw new NotFoundException(
        biBody('Canonical payment order not found', 'طلب الدفع الأساسي غير موجود'),
      );
    }
    await this.finalizer.finalizeSuccessfulPayment({
      orderId: payment.order_id,
      paymentId: payment.id,
      sourceReference:
        verification?.transactionId ?? payment.provider_reference ?? `payment-${payment.id}`,
      actorId: null,
      ...(verification !== undefined
        ? {
            verifiedAmountMinor: verification.amountCents,
            verifiedCurrency: verification.currency,
            ...(verification.occurredAt === undefined
              ? {}
              : { verifiedOccurredAt: verification.occurredAt }),
          }
        : {}),
    });
  }

  /**
   * Handle a refunded/voided transaction reported by the gateway. Marks the
   * payment REFUNDED (guarded so it never overwrites a still-pending charge into
   * a terminal state incorrectly, and is idempotent). Revenue reporting only
   * counts COMPLETED payments, so this immediately removes it from revenue.
   */
  public async processRefundedPayment(
    paymentId: string,
    verification?: PaymentVerificationContext,
  ): Promise<void> {
    const payment = await this.paymentsRepository.findOne({
      where: { id: paymentId },
    });
    if (!payment?.order_id) {
      throw new NotFoundException(
        biBody('Canonical payment order not found', 'طلب الدفع الأساسي غير موجود'),
      );
    }
    await this.refundsService.completeProviderNotification(
      paymentId,
      verification?.transactionId ?? payment.provider_reference ?? paymentId,
      verification?.amountCents ?? payment.amount_minor ?? 0,
      verification?.currency ?? payment.currency,
    );
  }

  /**
   * Process failed payment.
   *
   * Only a still-open payment (PENDING/PROCESSING) may transition to FAILED — a
   * late, out-of-order or replayed failure webhook must never overwrite a
   * payment that already COMPLETED (access granted) or was REFUNDED, which would
   * corrupt revenue reporting and hide granted access (payment-vs-failure race).
   */
  public async processFailedPayment(
    paymentId: string,
    failureReason?: string,
    verification?: PaymentVerificationContext,
  ): Promise<void> {
    const reason = failureReason ?? 'Payment declined';
    await retryTransaction(this.dataSource, async (manager) => {
      const payment = await manager.findOne(Payment, {
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment || ![PaymentStatus.PENDING, PaymentStatus.PROCESSING].includes(payment.status)) {
        this.logger.warn(
          `Ignoring failure webhook for payment ${paymentId}: not in an open state ` +
            `(already completed/refunded/failed)`,
        );
        return;
      }

      payment.status = PaymentStatus.FAILED;
      payment.failure_reason = reason;
      if (verification?.transactionId !== undefined) {
        payment.paymob_transaction_id = verification.transactionId;
      }
      await manager.save(Payment, payment);
      if (payment.order_id) {
        await manager.update(
          Order,
          {
            id: payment.order_id,
            status: In([
              OrderStatus.AWAITING_PAYMENT,
              OrderStatus.PAYMENT_SUBMITTED,
              OrderStatus.UNDER_REVIEW,
            ]),
          },
          { status: OrderStatus.REJECTED },
        );
      }

      // The charge never happened — hand back any discount use consumed at
      // initiation so the student can retry with the same code.
      await this.discountCodesService.releaseUsageForPayment(paymentId, manager);

      this.logger.log(`Payment ${paymentId} marked as failed: ${reason}`);
    });
  }

  /**
   * The student-facing ownership decision. New payments are always represented
   * by an entitlement; the lesson-purchase fallback below only preserves access
   * for pre-entitlement records while those records are migrated.
   */
  public async checkItemAccess(
    userId: string,
    itemType: ItemType,
    itemId: string,
  ): Promise<AccessCheckResult> {
    const entitlement = await this.entitlementsService.getActive(userId, itemType, itemId);
    if (entitlement) {
      if (!entitlement.expires_at) return { has_access: true };
      const daysRemaining = Math.ceil(
        (entitlement.expires_at.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      return {
        has_access: true,
        expires_at: entitlement.expires_at,
        days_remaining: daysRemaining,
      };
    }

    // A lesson can also be owned through an active package entitlement. This
    // is deliberately checked through EntitlementsService, so checkout and
    // content navigation use the same canonical ownership rule.
    if (await this.entitlementsService.hasItemAccess(userId, itemType, itemId)) {
      return { has_access: true };
    }

    if (itemType === ItemType.PACKAGE) {
      const purchase = await this.packagePurchasesRepository.findOne({
        where: { student_id: userId, package_id: itemId, revoked_at: IsNull() },
      });
      return { has_access: Boolean(purchase) };
    }

    if (itemType === ItemType.BOOK) {
      const purchase = await this.bookPurchasesRepository.findOne({
        where: { student_id: userId, book_id: itemId, revoked_at: IsNull() },
      });
      return { has_access: Boolean(purchase) };
    }

    const purchase = await this.lessonPurchasesRepository.findOne({
      where: {
        student_id: userId,
        lesson_id: itemId,
        access_expires_at: MoreThan(new Date()),
        revoked_at: IsNull(),
      },
    });

    if (!purchase) {
      return { has_access: false };
    }

    const now = new Date();
    const daysRemaining = Math.ceil(
      (purchase.access_expires_at.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      has_access: true,
      expires_at: purchase.access_expires_at,
      days_remaining: daysRemaining,
    };
  }

  /** @deprecated Use checkItemAccess so every item type follows one policy. */
  public async checkLessonAccess(userId: string, lessonId: string): Promise<AccessCheckResult> {
    return this.checkItemAccess(userId, ItemType.LESSON, lessonId);
  }

  /**
   * Extend lesson access by 1 day (admin only)
   */
  public async extendLessonAccess(purchaseId: string): Promise<LessonPurchase> {
    const purchase = await this.lessonPurchasesRepository.findOne({
      where: { id: purchaseId },
    });

    if (!purchase) {
      throw new NotFoundException(biBody('Purchase not found', 'عملية الشراء غير موجودة'));
    }

    // Extend by 1 day
    const newExpiresAt = new Date(purchase.access_expires_at);
    newExpiresAt.setDate(newExpiresAt.getDate() + 1);

    purchase.access_expires_at = newExpiresAt;
    purchase.days_extended += 1;

    const updated = await this.lessonPurchasesRepository.save(purchase);

    this.logger.log(
      `Extended lesson access: purchase ${purchaseId}, new expiry ${newExpiresAt.toISOString()}`,
    );

    return updated;
  }

  /**
   * Get student's purchased lessons (active access)
   */
  public async getMyLessons(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: LessonPurchase[]; meta: PaginationMeta }> {
    const [data, total] = await this.lessonPurchasesRepository.findAndCount({
      where: {
        student_id: userId,
        access_expires_at: MoreThan(new Date()),
        revoked_at: IsNull(),
      },
      relations: ['lesson', 'lesson.subject', 'lesson.teacher'],
      order: { access_expires_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Get student's purchased packages
   */
  public async getMyPackages(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: PackagePurchase[]; meta: PaginationMeta }> {
    const [data, total] = await this.packagePurchasesRepository.findAndCount({
      where: { student_id: userId, revoked_at: IsNull() },
      relations: ['package', 'package.teacher', 'package.items', 'package.items.lesson'],
      order: { purchased_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Whether a student may access a lesson through a purchase — either an active
   * individual lesson purchase (7-day window) or a package (course) enrolment
   * that contains the lesson (package purchases are permanent). Used to gate
   * signed video playback. Does not cover teacher-owner / admin access, which
   * the caller checks separately.
   */
  public async hasLessonPlaybackAccess(userId: string, lessonId: string): Promise<boolean> {
    if (await this.entitlementsService.hasItemAccess(userId, ItemType.LESSON, lessonId)) {
      return true;
    }
    const lessonPurchase = await this.lessonPurchasesRepository.findOne({
      where: {
        student_id: userId,
        lesson_id: lessonId,
        access_expires_at: MoreThan(new Date()),
        revoked_at: IsNull(),
      },
    });
    if (lessonPurchase) return true;

    // Enrolled via any package whose curriculum includes this lesson.
    const packageEnrolments = await this.packagePurchasesRepository
      .createQueryBuilder('purchase')
      .innerJoin('purchase.package', 'package')
      .innerJoin('package.items', 'item', 'item.lesson_id = :lessonId', {
        lessonId,
      })
      .where('purchase.student_id = :userId', { userId })
      .andWhere('purchase.revoked_at IS NULL')
      .getCount();

    return packageEnrolments > 0;
  }

  /**
   * Get student's purchase history
   */
  public async getMyPurchases(
    userId: string,
    filter: PaymentFilterDto,
  ): Promise<{ data: Payment[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.paymentsRepository
      .createQueryBuilder('payment')
      .where('payment.user_id = :userId', { userId });

    if (filter.status !== undefined) {
      queryBuilder.andWhere('payment.status = :status', {
        status: filter.status,
      });
    }

    if (filter.item_type !== undefined) {
      queryBuilder.andWhere('payment.item_type = :itemType', {
        itemType: filter.item_type,
      });
    }

    if (filter.from_date !== undefined && filter.from_date !== '') {
      queryBuilder.andWhere('payment.created_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (filter.to_date !== undefined && filter.to_date !== '') {
      queryBuilder.andWhere('payment.created_at <= :toDate', {
        toDate: filter.to_date,
      });
    }

    const sortBy = filter.sortBy ?? 'created_at';
    const sortColumn = PAYMENT_SORT_COLUMN_BY_FIELD[sortBy];
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    queryBuilder.orderBy(sortColumn, order);

    const [data, total] = await queryBuilder.skip(skip).take(limit).getManyAndCount();

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
   * Get all payments (admin)
   */
  public async getAllPayments(
    filter: PaymentFilterDto,
  ): Promise<{ data: Payment[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.paymentsRepository.createQueryBuilder('payment');

    if (filter.user_id !== undefined && filter.user_id !== '') {
      queryBuilder.andWhere('payment.user_id = :userId', {
        userId: filter.user_id,
      });
    }

    if (filter.status !== undefined) {
      queryBuilder.andWhere('payment.status = :status', {
        status: filter.status,
      });
    }

    if (filter.item_type !== undefined) {
      queryBuilder.andWhere('payment.item_type = :itemType', {
        itemType: filter.item_type,
      });
    }

    if (filter.from_date !== undefined && filter.from_date !== '') {
      queryBuilder.andWhere('payment.created_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (filter.to_date !== undefined && filter.to_date !== '') {
      queryBuilder.andWhere('payment.created_at <= :toDate', {
        toDate: filter.to_date,
      });
    }

    const sortBy = filter.sortBy ?? 'created_at';
    const sortColumn = PAYMENT_SORT_COLUMN_BY_FIELD[sortBy];
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    queryBuilder.orderBy(sortColumn, order);

    queryBuilder.leftJoinAndSelect('payment.user', 'user');

    const [data, total] = await queryBuilder.skip(skip).take(limit).getManyAndCount();

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
   * Get payment by ID
   */
  public async getPaymentById(paymentId: string): Promise<Payment | null> {
    return await this.paymentsRepository.findOne({
      where: { id: paymentId },
      relations: ['user'],
    });
  }

  /**
   * Get payment by merchant order ID (our payment.id - UUID)
   */
  public async getPaymentByMerchantOrderId(merchantOrderId: string): Promise<Payment | null> {
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(merchantOrderId)) {
      return null;
    }
    return await this.paymentsRepository.findOne({
      where: { id: merchantOrderId },
    });
  }

  /**
   * Get all lesson purchases (admin)
   */
  public async getAllLessonPurchases(
    page = 1,
    limit = 20,
  ): Promise<{ data: LessonPurchase[]; meta: PaginationMeta }> {
    const skip = (page - 1) * limit;

    const [data, total] = await this.lessonPurchasesRepository.findAndCount({
      relations: ['student', 'lesson', 'payment'],
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

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
   * Get revenue statistics (admin)
   */
  public async getRevenueStatistics(fromDate?: Date, toDate?: Date): Promise<RevenueStatistics> {
    const queryBuilder = this.canonicalPaidOrderRevenueQuery(fromDate, toDate)
      .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total_revenue')
      .addSelect('COUNT(order.id)', 'total_payments')
      .addSelect('COALESCE(SUM(order.discount_amount_minor), 0) / 100.0', 'total_discounts');

    const result = (await queryBuilder.getRawOne<RevenueRawResult>()) ?? {
      total_revenue: null,

      total_payments: null,

      total_discounts: null,
    };

    return {
      total_revenue: result.total_revenue === null ? 0 : Number.parseFloat(result.total_revenue),

      total_payments:
        result.total_payments === null ? 0 : Number.parseInt(result.total_payments, 10),

      total_discounts:
        result.total_discounts === null ? 0 : Number.parseFloat(result.total_discounts),
    };
  }

  /**

     * Get teacher revenue base query with common filters

     */

  private getTeacherRevenueBaseQuery(
    teacherId: string,

    fromDate?: string,

    toDate?: string,
  ): SelectQueryBuilder<Order> {
    return this.canonicalPaidOrderRevenueQuery(
      fromDate === '' ? undefined : fromDate,
      toDate === '' ? undefined : toDate,
    ).andWhere('order.teacher_id = :teacherId', { teacherId });
  }

  /**

     * Get teacher revenue with date range filtering and grouping

     */

  public async getTeacherRevenue(
    teacherId: string,

    fromDate?: string,

    toDate?: string,

    groupBy: 'day' | 'week' | 'month' = 'month',
  ): Promise<{
    total_revenue: number;

    revenue_by_period: Array<{
      period: string;

      revenue: number;

      sales: number;
    }>;

    top_lessons: Array<{
      lesson_id: string;

      lesson_title: string;

      revenue: number;

      sales: number;
    }>;

    date_range: { from: string | undefined; to: string | undefined };
  }> {
    // Get total revenue for this teacher

    const totalQuery = this.getTeacherRevenueBaseQuery(
      teacherId,

      fromDate,

      toDate,
    );

    const totalResult = (await totalQuery

      .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total')

      .getRawOne<TeacherRevenueTotalRaw>()) ?? { total: null };

    // Get revenue grouped by period

    const dateFormats = new Map<string, string>([
      ['day', 'YYYY-MM-DD'],

      ['week', 'IYYY-IW'],

      ['month', 'YYYY-MM'],
    ]);

    const dateFormat = dateFormats.get(groupBy) ?? 'YYYY-MM-DD';

    const periodQuery = this.getTeacherRevenueBaseQuery(
      teacherId,

      fromDate,

      toDate,
    );

    const periodResults = await periodQuery

      .select(`TO_CHAR(order.paid_at, '${dateFormat}')`, 'period')

      .addSelect('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'revenue')

      .addSelect('COUNT(order.id)', 'sales')

      .groupBy('period')

      .orderBy('period', 'DESC')

      .getRawMany<TeacherRevenuePeriodRaw>();

    // Get top performing lessons

    const topLessonsQuery = this.getTeacherRevenueBaseQuery(
      teacherId,

      fromDate,

      toDate,
    );

    const topLessons = await topLessonsQuery

      .andWhere('order.item_type = :lessonType', { lessonType: ItemType.LESSON })

      .select('order.item_id', 'lesson_id')

      .addSelect('MAX(order.product_title_snapshot)', 'lesson_title')

      .addSelect('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'revenue')

      .addSelect('COUNT(order.id)', 'sales')

      .groupBy('order.item_id')

      .orderBy('revenue', 'DESC')

      .limit(5)

      .getRawMany<TeacherTopLessonsRaw>();

    return {
      total_revenue: totalResult.total === null ? 0 : Number(totalResult.total),

      revenue_by_period: periodResults.map((r) => ({
        period: r.period,

        revenue: Number(r.revenue),

        sales: Number(r.sales),
      })),

      top_lessons: topLessons.map((l) => ({
        lesson_id: l.lesson_id,

        lesson_title: l.lesson_title,

        revenue: Number(l.revenue),

        sales: Number(l.sales),
      })),

      date_range: { from: fromDate, to: toDate },
    };
  }

  /**
   * Get revenue breakdown by lesson for a teacher
   */
  public async getTeacherRevenueByLesson(teacherId: string): Promise<{
    lessons: Array<{
      lesson_id: string;
      lesson_title: string;
      purchase_count: number;
      total_revenue: number;
      avg_price: number;
    }>;
  }> {
    const results = await this.getTeacherRevenueBaseQuery(teacherId)
      .andWhere('order.item_type = :lessonType', { lessonType: ItemType.LESSON })
      .select([
        'order.item_id AS lesson_id',
        'MAX(order.product_title_snapshot) AS lesson_title',
        'COUNT(order.id) AS purchase_count',
        'COALESCE(SUM(order.final_amount_minor), 0) / 100.0 AS total_revenue',
        'COALESCE(AVG(order.final_amount_minor), 0) / 100.0 AS avg_price',
      ])
      .groupBy('order.item_id')
      .orderBy('total_revenue', 'DESC')
      .getRawMany<TeacherRevenueByLessonRaw>();

    return {
      lessons: results.map((l) => ({
        lesson_id: l.lesson_id,
        lesson_title: l.lesson_title,
        purchase_count: Number(l.purchase_count),
        total_revenue: Number(l.total_revenue),
        avg_price: Number(l.avg_price),
      })),
    };
  }

  /**
   * Get revenue breakdown by package for a teacher
   */
  public async getTeacherRevenueByPackage(teacherId: string): Promise<{
    packages: Array<{
      package_id: string;
      package_title: string;
      purchase_count: number;
      total_revenue: number;
      avg_price: number;
    }>;
  }> {
    const results = await this.getTeacherRevenueBaseQuery(teacherId)
      .andWhere('order.item_type = :packageType', { packageType: ItemType.PACKAGE })
      .select([
        'order.item_id AS package_id',
        'MAX(order.product_title_snapshot) AS package_title',
        'COUNT(order.id) AS purchase_count',
        'COALESCE(SUM(order.final_amount_minor), 0) / 100.0 AS total_revenue',
        'COALESCE(AVG(order.final_amount_minor), 0) / 100.0 AS avg_price',
      ])
      .groupBy('order.item_id')
      .orderBy('total_revenue', 'DESC')
      .getRawMany<TeacherRevenueByPackageRaw>();

    return {
      packages: results.map((p) => ({
        package_id: p.package_id,
        package_title: p.package_title,
        purchase_count: Number(p.purchase_count),
        total_revenue: Number(p.total_revenue),
        avg_price: Number(p.avg_price),
      })),
    };
  }

  /**
   * The canonical revenue source for every financial statistic in this service:
   * a confirmed paid order, its completed payment, and order.paid_at.
   */
  private canonicalPaidOrderRevenueQuery(fromDate?: Date | string, toDate?: Date | string) {
    const query = this.dataSource
      .getRepository(Order)
      .createQueryBuilder('order')
      .innerJoin(
        Payment,
        'payment',
        'payment.id = order.payment_id AND payment.status = :completedPaymentStatus',
        { completedPaymentStatus: PaymentStatus.COMPLETED },
      )
      .where('order.status = :paidOrderStatus', { paidOrderStatus: OrderStatus.PAID })
      .andWhere('order.paid_at IS NOT NULL');
    if (fromDate !== undefined) query.andWhere('order.paid_at >= :fromDate', { fromDate });
    if (toDate !== undefined) query.andWhere('order.paid_at <= :toDate', { toDate });
    return query;
  }
}
