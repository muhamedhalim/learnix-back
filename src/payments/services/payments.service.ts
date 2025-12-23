import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  IsNull,
  LessThanOrEqual,
  MoreThan,
} from 'typeorm';
import {
  Payment,
  PaymentStatus,
  PaymentMethod,
  ItemType,
  LessonPurchase,
  PackagePurchase,
} from '../entities';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { PurchaseLessonDto } from '../dto/purchase-lesson.dto';
import { PurchasePackageDto } from '../dto/purchase-package.dto';
import { PaymentFilterDto } from '../dto/payment-filter.dto';
import { BillingDataDto } from '../dto/billing-data.dto';
import { PaymobService } from './paymob.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { ApplicableItem } from '../../discount-codes/entities/applicable-item.enum';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';

export interface PaymentResponse {
  payment_id: number;
  payment_key: string;
  paymob_order_id: number;
  amount: number;
  discount_amount: number;
  final_amount: number;
  iframe_url: string;
}

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
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    private readonly dataSource: DataSource,
    private readonly paymobService: PaymobService,
    private readonly idempotencyService: IdempotencyService,
    @Inject(forwardRef(() => DiscountCodesService))
    private readonly discountCodesService: DiscountCodesService,
  ) {}

  /**
   * Purchase a lesson - initiates payment with Paymob
   */
  async purchaseLesson(
    dto: PurchaseLessonDto,
    userId: number,
  ): Promise<PaymentResponse> {
    // Generate idempotency key if not provided
    const idempotencyKey =
      dto.idempotency_key || `lesson-${userId}-${dto.lesson_id}-${Date.now()}`;

    // Check idempotency
    const idempotencyCheck =
      await this.idempotencyService.checkPaymentRequest<PaymentResponse>(
        userId,
        idempotencyKey,
      );
    if (idempotencyCheck.isProcessed && idempotencyCheck.cachedResult) {
      this.logger.log(`Returning cached payment response for user ${userId}`);
      return idempotencyCheck.cachedResult;
    }

    // Get lesson
    const lesson = await this.lessonsRepository.findOne({
      where: { id: dto.lesson_id, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    // Check if student already has active access
    const existingAccess = await this.checkLessonAccess(userId, dto.lesson_id);
    if (existingAccess.has_access) {
      throw new ConflictException(
        `You already have access to this lesson until ${existingAccess.expires_at?.toISOString()}`,
      );
    }

    // Apply discount code if provided
    let discountAmount = 0;
    let discountCodeId: number | null = null;

    if (dto.discount_code) {
      const verification = await this.discountCodesService.verifyCode(
        {
          code: dto.discount_code,
          item_type: ApplicableItem.LESSON,
          item_id: dto.lesson_id,
          amount: Number(lesson.price),
        },
        userId,
      );

      if (!verification.valid) {
        throw new BadRequestException(verification.error);
      }

      discountAmount = verification.discount_amount!;
      discountCodeId = verification.discount_code_id!;
    }

    const finalAmount = Number(lesson.price) - discountAmount;

    // Create payment using transaction
    return await retryTransaction(this.dataSource, async (manager) => {
      // Create payment record
      const payment = manager.create(Payment, {
        user_id: userId,
        item_type: ItemType.LESSON,
        item_id: dto.lesson_id,
        amount: lesson.price,
        discount_amount: discountAmount,
        final_amount: finalAmount,
        status: PaymentStatus.PENDING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: idempotencyKey,
      });

      const savedPayment = await manager.save(Payment, payment);

      // Apply discount code if used (within transaction for atomicity)
      if (discountCodeId) {
        await this.discountCodesService.applyDiscount(
          discountCodeId,
          userId,
          savedPayment.id,
          discountAmount,
          manager,
        );
      }

      // Initiate Paymob payment
      const paymobResult = await this.paymobService.initiatePayment(
        finalAmount,
        savedPayment.id.toString(),
        dto.billing_data,
      );

      // Update payment with Paymob order ID
      savedPayment.paymob_order_id = paymobResult.paymobOrderId.toString();
      savedPayment.status = PaymentStatus.PROCESSING;
      await manager.save(Payment, savedPayment);

      const response: PaymentResponse = {
        payment_id: savedPayment.id,
        payment_key: paymobResult.paymentKey,
        paymob_order_id: paymobResult.paymobOrderId,
        amount: Number(lesson.price),
        discount_amount: discountAmount,
        final_amount: finalAmount,
        iframe_url: paymobResult.iframeUrl,
      };

      // Store idempotency result
      await this.idempotencyService.storePaymentResult(
        userId,
        idempotencyKey,
        response,
      );

      this.logger.log(
        `Payment ${savedPayment.id} initiated for lesson ${dto.lesson_id} by user ${userId}`,
      );

      return response;
    });
  }

  /**
   * Purchase a package - initiates payment with Paymob
   */
  async purchasePackage(
    dto: PurchasePackageDto,
    userId: number,
  ): Promise<PaymentResponse> {
    // Generate idempotency key if not provided
    const idempotencyKey =
      dto.idempotency_key ||
      `package-${userId}-${dto.package_id}-${Date.now()}`;

    // Check idempotency
    const idempotencyCheck =
      await this.idempotencyService.checkPaymentRequest<PaymentResponse>(
        userId,
        idempotencyKey,
      );
    if (idempotencyCheck.isProcessed && idempotencyCheck.cachedResult) {
      this.logger.log(`Returning cached payment response for user ${userId}`);
      return idempotencyCheck.cachedResult;
    }

    // Get package
    const pkg = await this.packagesRepository.findOne({
      where: { id: dto.package_id, deleted_at: IsNull(), is_active: true },
      relations: ['items', 'items.lesson'],
    });

    if (!pkg) {
      throw new NotFoundException('Package not found or not active');
    }

    // Apply discount code if provided
    let discountAmount = 0;
    let discountCodeId: number | null = null;

    if (dto.discount_code) {
      const verification = await this.discountCodesService.verifyCode(
        {
          code: dto.discount_code,
          item_type: ApplicableItem.PACKAGE,
          item_id: dto.package_id,
          amount: Number(pkg.price),
        },
        userId,
      );

      if (!verification.valid) {
        throw new BadRequestException(verification.error);
      }

      discountAmount = verification.discount_amount!;
      discountCodeId = verification.discount_code_id!;
    }

    const finalAmount = Number(pkg.price) - discountAmount;

    // Create payment using transaction
    return await retryTransaction(this.dataSource, async (manager) => {
      // Create payment record
      const payment = manager.create(Payment, {
        user_id: userId,
        item_type: ItemType.PACKAGE,
        item_id: dto.package_id,
        amount: pkg.price,
        discount_amount: discountAmount,
        final_amount: finalAmount,
        status: PaymentStatus.PENDING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: idempotencyKey,
      });

      const savedPayment = await manager.save(Payment, payment);

      // Apply discount code if used (within transaction for atomicity)
      if (discountCodeId) {
        await this.discountCodesService.applyDiscount(
          discountCodeId,
          userId,
          savedPayment.id,
          discountAmount,
          manager,
        );
      }

      // Initiate Paymob payment
      const paymobResult = await this.paymobService.initiatePayment(
        finalAmount,
        savedPayment.id.toString(),
        dto.billing_data,
      );

      // Update payment with Paymob order ID
      savedPayment.paymob_order_id = paymobResult.paymobOrderId.toString();
      savedPayment.status = PaymentStatus.PROCESSING;
      await manager.save(Payment, savedPayment);

      const response: PaymentResponse = {
        payment_id: savedPayment.id,
        payment_key: paymobResult.paymentKey,
        paymob_order_id: paymobResult.paymobOrderId,
        amount: Number(pkg.price),
        discount_amount: discountAmount,
        final_amount: finalAmount,
        iframe_url: paymobResult.iframeUrl,
      };

      // Store idempotency result
      await this.idempotencyService.storePaymentResult(
        userId,
        idempotencyKey,
        response,
      );

      this.logger.log(
        `Payment ${savedPayment.id} initiated for package ${dto.package_id} by user ${userId}`,
      );

      return response;
    });
  }

  /**
   * Reopen an expired lesson at 50% price
   */
  async reopenLesson(
    lessonId: number,
    userId: number,
    billingData: BillingDataDto,
  ): Promise<PaymentResponse> {
    // Find expired purchase
    const expiredPurchase = await this.lessonPurchasesRepository.findOne({
      where: {
        student_id: userId,
        lesson_id: lessonId,
        access_expires_at: LessThanOrEqual(new Date()),
      },
      relations: ['lesson'],
    });

    if (!expiredPurchase) {
      throw new BadRequestException(
        'You have not previously purchased this lesson or access is still active',
      );
    }

    // Get current lesson price
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    // Calculate 50% reopen price
    const reopenPrice = Number(lesson.price) * 0.5;
    const idempotencyKey = `reopen-${userId}-${lessonId}-${Date.now()}`;

    // Create payment using transaction
    return await retryTransaction(this.dataSource, async (manager) => {
      const payment = manager.create(Payment, {
        user_id: userId,
        item_type: ItemType.LESSON,
        item_id: lessonId,
        amount: reopenPrice,
        discount_amount: 0, // No additional discounts on reopen
        final_amount: reopenPrice,
        status: PaymentStatus.PENDING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: idempotencyKey,
      });

      const savedPayment = await manager.save(Payment, payment);

      // Initiate Paymob payment
      const paymobResult = await this.paymobService.initiatePayment(
        reopenPrice,
        savedPayment.id.toString(),
        billingData,
      );

      savedPayment.paymob_order_id = paymobResult.paymobOrderId.toString();
      savedPayment.status = PaymentStatus.PROCESSING;
      await manager.save(Payment, savedPayment);

      this.logger.log(
        `Reopen payment ${savedPayment.id} initiated for lesson ${lessonId} by user ${userId} at 50% price`,
      );

      return {
        payment_id: savedPayment.id,
        payment_key: paymobResult.paymentKey,
        paymob_order_id: paymobResult.paymobOrderId,
        amount: reopenPrice,
        discount_amount: 0,
        final_amount: reopenPrice,
        iframe_url: paymobResult.iframeUrl,
      };
    });
  }

  /**
   * Process successful payment - grant access
   */
  async processSuccessfulPayment(paymentId: number): Promise<void> {
    await retryTransaction(this.dataSource, async (manager) => {
      const payment = await manager.findOne(Payment, {
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!payment) {
        throw new NotFoundException('Payment not found');
      }

      if (payment.status === PaymentStatus.COMPLETED) {
        this.logger.log(`Payment ${paymentId} already completed, skipping`);
        return;
      }

      // Update payment status
      payment.status = PaymentStatus.COMPLETED;
      await manager.save(Payment, payment);

      // Grant access based on item type
      if (payment.item_type === ItemType.LESSON) {
        await this.grantLessonAccess(manager, payment);
      } else if (payment.item_type === ItemType.PACKAGE) {
        await this.grantPackageAccess(manager, payment);
      }

      this.logger.log(
        `Payment ${paymentId} completed successfully, access granted`,
      );
    });
  }

  /**
   * Grant access to a lesson (7-day rule)
   */
  private async grantLessonAccess(
    manager: EntityManager,
    payment: Payment,
  ): Promise<void> {
    // Get lesson to check available_for_days
    const lesson = await manager.findOne(Lesson, {
      where: { id: payment.item_id },
    });

    const accessDays = lesson?.available_for_days || 7;
    const accessGrantedAt = new Date();
    const accessExpiresAt = new Date(accessGrantedAt);
    accessExpiresAt.setDate(accessExpiresAt.getDate() + accessDays);

    const lessonPurchase = manager.create(LessonPurchase, {
      student_id: payment.user_id,
      lesson_id: payment.item_id,
      payment_id: payment.id,
      price_paid: payment.final_amount,
      access_granted_at: accessGrantedAt,
      access_expires_at: accessExpiresAt,
      days_extended: 0,
    });

    await manager.save(LessonPurchase, lessonPurchase);

    // Update lesson students_count
    await manager.increment(
      Lesson,
      { id: payment.item_id },
      'students_count',
      1,
    );

    this.logger.log(
      `Lesson access granted: user ${payment.user_id}, lesson ${payment.item_id}, ` +
        `expires at ${accessExpiresAt.toISOString()}`,
    );
  }

  /**
   * Grant access to all lessons in a package
   */
  private async grantPackageAccess(
    manager: EntityManager,
    payment: Payment,
  ): Promise<void> {
    // Get package with lessons
    const pkg = await manager.findOne(LessonPackage, {
      where: { id: payment.item_id },
      relations: ['items', 'items.lesson'],
    });

    if (!pkg) {
      throw new NotFoundException('Package not found');
    }

    // Create package purchase record
    const packagePurchase = manager.create(PackagePurchase, {
      student_id: payment.user_id,
      package_id: payment.item_id,
      payment_id: payment.id,
      price_paid: payment.final_amount,
      purchased_at: new Date(),
    });

    await manager.save(PackagePurchase, packagePurchase);

    // Grant access to each lesson in the package
    for (const item of pkg.items) {
      const lesson = item.lesson;
      if (!lesson) continue;

      const accessDays = lesson.available_for_days || 7;
      const accessGrantedAt = new Date();
      const accessExpiresAt = new Date(accessGrantedAt);
      accessExpiresAt.setDate(accessExpiresAt.getDate() + accessDays);

      const lessonPurchase = manager.create(LessonPurchase, {
        student_id: payment.user_id,
        lesson_id: lesson.id,
        payment_id: payment.id,
        price_paid: 0, // Individual lessons in package have 0 price
        access_granted_at: accessGrantedAt,
        access_expires_at: accessExpiresAt,
        days_extended: 0,
      });

      await manager.save(LessonPurchase, lessonPurchase);
      await manager.increment(Lesson, { id: lesson.id }, 'students_count', 1);
    }

    this.logger.log(
      `Package access granted: user ${payment.user_id}, package ${payment.item_id}, ` +
        `${pkg.items.length} lessons`,
    );
  }

  /**
   * Process failed payment
   */
  async processFailedPayment(
    paymentId: number,
    failureReason?: string,
  ): Promise<void> {
    await this.paymentsRepository.update(paymentId, {
      status: PaymentStatus.FAILED,
      failure_reason: failureReason || 'Payment declined',
    });

    this.logger.log(`Payment ${paymentId} marked as failed: ${failureReason}`);
  }

  /**
   * Check if student has active access to a lesson
   */
  async checkLessonAccess(
    userId: number,
    lessonId: number,
  ): Promise<AccessCheckResult> {
    const purchase = await this.lessonPurchasesRepository.findOne({
      where: {
        student_id: userId,
        lesson_id: lessonId,
        access_expires_at: MoreThan(new Date()),
      },
    });

    if (!purchase) {
      return { has_access: false };
    }

    const now = new Date();
    const daysRemaining = Math.ceil(
      (purchase.access_expires_at.getTime() - now.getTime()) /
        (1000 * 60 * 60 * 24),
    );

    return {
      has_access: true,
      expires_at: purchase.access_expires_at,
      days_remaining: daysRemaining,
    };
  }

  /**
   * Extend lesson access by 1 day (admin only)
   */
  async extendLessonAccess(purchaseId: number): Promise<LessonPurchase> {
    const purchase = await this.lessonPurchasesRepository.findOne({
      where: { id: purchaseId },
    });

    if (!purchase) {
      throw new NotFoundException('Purchase not found');
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
  async getMyLessons(userId: number): Promise<LessonPurchase[]> {
    return await this.lessonPurchasesRepository.find({
      where: {
        student_id: userId,
        access_expires_at: MoreThan(new Date()),
      },
      relations: ['lesson', 'lesson.subject', 'lesson.teacher'],
      order: { access_expires_at: 'ASC' },
    });
  }

  /**
   * Get student's purchased packages
   */
  async getMyPackages(userId: number): Promise<PackagePurchase[]> {
    return await this.packagePurchasesRepository.find({
      where: { student_id: userId },
      relations: [
        'package',
        'package.teacher',
        'package.items',
        'package.items.lesson',
      ],
      order: { purchased_at: 'DESC' },
    });
  }

  /**
   * Get student's purchase history
   */
  async getMyPurchases(
    userId: number,
    filter: PaymentFilterDto,
  ): Promise<{ data: Payment[]; meta: PaginationMeta }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.paymentsRepository
      .createQueryBuilder('payment')
      .where('payment.user_id = :userId', { userId });

    if (filter.status) {
      queryBuilder.andWhere('payment.status = :status', {
        status: filter.status,
      });
    }

    if (filter.item_type) {
      queryBuilder.andWhere('payment.item_type = :itemType', {
        itemType: filter.item_type,
      });
    }

    if (filter.from_date) {
      queryBuilder.andWhere('payment.created_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (filter.to_date) {
      queryBuilder.andWhere('payment.created_at <= :toDate', {
        toDate: filter.to_date,
      });
    }

    const sortBy = filter.sortBy || 'created_at';
    const order = filter.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    queryBuilder.orderBy(`payment.${sortBy}`, order);

    const [data, total] = await queryBuilder
      .skip(skip)
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
   * Get all payments (admin)
   */
  async getAllPayments(
    filter: PaymentFilterDto,
  ): Promise<{ data: Payment[]; meta: PaginationMeta }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.paymentsRepository.createQueryBuilder('payment');

    if (filter.user_id) {
      queryBuilder.andWhere('payment.user_id = :userId', {
        userId: filter.user_id,
      });
    }

    if (filter.status) {
      queryBuilder.andWhere('payment.status = :status', {
        status: filter.status,
      });
    }

    if (filter.item_type) {
      queryBuilder.andWhere('payment.item_type = :itemType', {
        itemType: filter.item_type,
      });
    }

    if (filter.from_date) {
      queryBuilder.andWhere('payment.created_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (filter.to_date) {
      queryBuilder.andWhere('payment.created_at <= :toDate', {
        toDate: filter.to_date,
      });
    }

    const sortBy = filter.sortBy || 'created_at';
    const order = filter.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    queryBuilder.orderBy(`payment.${sortBy}`, order);

    queryBuilder.leftJoinAndSelect('payment.user', 'user');

    const [data, total] = await queryBuilder
      .skip(skip)
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
   * Get payment by ID
   */
  async getPaymentById(paymentId: number): Promise<Payment | null> {
    return await this.paymentsRepository.findOne({
      where: { id: paymentId },
      relations: ['user'],
    });
  }

  /**
   * Get payment by merchant order ID (our payment.id)
   */
  async getPaymentByMerchantOrderId(
    merchantOrderId: string,
  ): Promise<Payment | null> {
    const paymentId = parseInt(merchantOrderId, 10);
    if (isNaN(paymentId)) {
      return null;
    }
    return await this.paymentsRepository.findOne({
      where: { id: paymentId },
    });
  }

  /**
   * Get all lesson purchases (admin)
   */
  async getAllLessonPurchases(
    page: number = 1,
    limit: number = 20,
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
  async getRevenueStatistics(
    fromDate?: Date,
    toDate?: Date,
  ): Promise<RevenueStatistics> {
    const queryBuilder = this.paymentsRepository
      .createQueryBuilder('payment')
      .select('SUM(payment.final_amount)', 'total_revenue')
      .addSelect('COUNT(*)', 'total_payments')
      .addSelect('SUM(payment.discount_amount)', 'total_discounts')
      .where('payment.status = :status', { status: PaymentStatus.COMPLETED });

    if (fromDate) {
      queryBuilder.andWhere('payment.created_at >= :fromDate', { fromDate });
    }

    if (toDate) {
      queryBuilder.andWhere('payment.created_at <= :toDate', { toDate });
    }

    const result =
      (await queryBuilder.getRawOne<RevenueRawResult>()) as RevenueRawResult;

    return {
      total_revenue: parseFloat(result?.total_revenue ?? '0') || 0,
      total_payments: parseInt(result?.total_payments ?? '0', 10) || 0,
      total_discounts: parseFloat(result?.total_discounts ?? '0') || 0,
    };
  }
}
