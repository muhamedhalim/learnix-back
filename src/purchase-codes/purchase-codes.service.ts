import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThan, IsNull } from 'typeorm';
import * as crypto from 'crypto';
import { PurchaseCode, PurchaseCodeType } from './entities';
import {
  GeneratePurchaseCodesDto,
  VerifyPurchaseCodeDto,
  PurchaseCodeFilterDto,
} from './dto';
import {
  Payment,
  PaymentStatus,
  PaymentMethod,
  ItemType,
  LessonPurchase,
  PackagePurchase,
} from '../payments/entities';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { retryTransaction } from '../common/utils/transaction-retry.util';
import { PaginationMeta } from '../common/interfaces/pagination.interface';

@Injectable()
export class PurchaseCodesService {
  private readonly logger = new Logger(PurchaseCodesService.name);

  constructor(
    @InjectRepository(PurchaseCode)
    private readonly purchaseCodesRepository: Repository<PurchaseCode>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Generate cryptographically secure purchase codes
   */
  async generateCodes(
    dto: GeneratePurchaseCodesDto,
    adminId: string,
  ): Promise<PurchaseCode[]> {
    // Validate item exists
    if (dto.type === PurchaseCodeType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: dto.item_id, deleted_at: IsNull() },
      });
      if (!lesson) {
        throw new NotFoundException('Lesson not found');
      }
    } else if (dto.type === PurchaseCodeType.PACKAGE) {
      const pkg = await this.packagesRepository.findOne({
        where: { id: dto.item_id, deleted_at: IsNull() },
      });
      if (!pkg) {
        throw new NotFoundException('Package not found');
      }
    }

    const codes: PurchaseCode[] = [];
    const expiresAt = new Date(dto.expires_at);

    for (let i = 0; i < dto.count; i++) {
      const code = this.generateUniqueCode();

      const purchaseCode = this.purchaseCodesRepository.create({
        code,
        type: dto.type,
        item_id: dto.item_id,
        expires_at: expiresAt,
        created_by: adminId,
      });

      codes.push(purchaseCode);
    }

    const savedCodes = await this.purchaseCodesRepository.save(codes);
    this.logger.log(
      `Generated ${dto.count} purchase codes for ${dto.type} ${dto.item_id} by admin ${adminId}`,
    );

    return savedCodes;
  }

  /**
   * Generate a unique 8-character alphanumeric code
   */
  private generateUniqueCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding similar chars (0, O, 1, I)
    let code = '';
    const randomBytesArray = crypto.randomBytes(8);

    for (let i = 0; i < 8; i++) {
      const byteValue = randomBytesArray[i] as number;
      code += chars[byteValue % chars.length];
    }

    return code;
  }

  /**
   * Verify and redeem a purchase code (with race condition protection)
   */
  async verifyAndRedeem(
    dto: VerifyPurchaseCodeDto,
    userId: string,
  ): Promise<Payment> {
    return await retryTransaction(this.dataSource, async (manager) => {
      // Find unused, unexpired code with pessimistic lock
      const code = await manager.findOne(PurchaseCode, {
        where: {
          code: dto.code.toUpperCase(),
          is_used: false,
          expires_at: MoreThan(new Date()),
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (!code) {
        throw new NotFoundException('Invalid or expired purchase code');
      }

      // Mark as used
      code.is_used = true;
      code.used_by = userId;
      code.used_at = new Date();
      await manager.save(PurchaseCode, code);

      // Create free payment
      const itemType =
        code.type === PurchaseCodeType.LESSON
          ? ItemType.LESSON
          : code.type === PurchaseCodeType.PACKAGE
            ? ItemType.PACKAGE
            : ItemType.BOOK;

      const payment = manager.create(Payment, {
        user_id: userId,
        item_type: itemType,
        item_id: code.item_id,
        amount: 0,
        discount_amount: 0,
        final_amount: 0,
        payment_method: PaymentMethod.PURCHASE_CODE,
        status: PaymentStatus.COMPLETED,
        idempotency_key: `purchase-code-${code.id}-${userId}`,
      });

      const savedPayment = await manager.save(Payment, payment);

      // Grant access immediately
      if (code.type === PurchaseCodeType.LESSON) {
        await this.grantLessonAccess(manager, savedPayment, code.item_id);
      } else if (code.type === PurchaseCodeType.PACKAGE) {
        await this.grantPackageAccess(manager, savedPayment, code.item_id);
      }

      this.logger.log(
        `Purchase code ${code.code} redeemed by user ${userId} for ${code.type} ${code.item_id}`,
      );

      return savedPayment;
    });
  }

  /**
   * Grant lesson access (7-day rule)
   */
  private async grantLessonAccess(
    manager: ReturnType<DataSource['createEntityManager']>,
    payment: Payment,
    lessonId: string,
  ): Promise<void> {
    const lesson = await manager.findOne(Lesson, {
      where: { id: lessonId },
    });

    const accessDays = lesson?.available_for_days || 7;
    const accessGrantedAt = new Date();
    const accessExpiresAt = new Date(accessGrantedAt);
    accessExpiresAt.setDate(accessExpiresAt.getDate() + accessDays);

    const lessonPurchase = manager.create(LessonPurchase, {
      student_id: payment.user_id,
      lesson_id: lessonId,
      payment_id: payment.id,
      price_paid: 0,
      access_granted_at: accessGrantedAt,
      access_expires_at: accessExpiresAt,
      days_extended: 0,
    });

    await manager.save(LessonPurchase, lessonPurchase);
    await manager.increment(Lesson, { id: lessonId }, 'students_count', 1);
  }

  /**
   * Grant package access (all lessons)
   */
  private async grantPackageAccess(
    manager: ReturnType<DataSource['createEntityManager']>,
    payment: Payment,
    packageId: string,
  ): Promise<void> {
    const pkg = await manager.findOne(LessonPackage, {
      where: { id: packageId },
      relations: ['items', 'items.lesson'],
    });

    if (!pkg) {
      throw new NotFoundException('Package not found');
    }

    // Create package purchase
    const packagePurchase = manager.create(PackagePurchase, {
      student_id: payment.user_id,
      package_id: packageId,
      payment_id: payment.id,
      price_paid: 0,
      purchased_at: new Date(),
    });

    await manager.save(PackagePurchase, packagePurchase);

    // Grant access to each lesson
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
        price_paid: 0,
        access_granted_at: accessGrantedAt,
        access_expires_at: accessExpiresAt,
        days_extended: 0,
      });

      await manager.save(LessonPurchase, lessonPurchase);
      await manager.increment(Lesson, { id: lesson.id }, 'students_count', 1);
    }
  }

  /**
   * Find all purchase codes with filters (admin only)
   */
  async findAll(
    filter: PurchaseCodeFilterDto,
  ): Promise<{ data: PurchaseCode[]; meta: PaginationMeta }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.purchaseCodesRepository
      .createQueryBuilder('code')
      .leftJoinAndSelect('code.user', 'user')
      .leftJoinAndSelect('code.creator', 'creator');

    if (filter.is_used !== undefined) {
      queryBuilder.andWhere('code.is_used = :isUsed', {
        isUsed: filter.is_used,
      });
    }

    if (filter.type) {
      queryBuilder.andWhere('code.type = :type', { type: filter.type });
    }

    if (filter.item_id) {
      queryBuilder.andWhere('code.item_id = :itemId', {
        itemId: filter.item_id,
      });
    }

    if (!filter.include_expired) {
      queryBuilder.andWhere('code.expires_at > :now', { now: new Date() });
    }

    queryBuilder.orderBy('code.created_at', 'DESC');

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
   * Find a purchase code by code string
   */
  async findByCode(code: string): Promise<PurchaseCode | null> {
    return await this.purchaseCodesRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['user', 'creator'],
    });
  }

  /**
   * Delete an unused purchase code (admin only)
   */
  async remove(code: string): Promise<void> {
    const purchaseCode = await this.purchaseCodesRepository.findOne({
      where: { code: code.toUpperCase() },
    });

    if (!purchaseCode) {
      throw new NotFoundException('Purchase code not found');
    }

    if (purchaseCode.is_used) {
      throw new BadRequestException('Cannot delete a used purchase code');
    }

    await this.purchaseCodesRepository.remove(purchaseCode);
    this.logger.log(`Deleted purchase code: ${code}`);
  }

  /**
   * Get statistics for purchase codes
   */
  async getStats(): Promise<{
    total: number;
    used: number;
    unused: number;
    expired: number;
  }> {
    const now = new Date();

    const total = await this.purchaseCodesRepository.count();
    const used = await this.purchaseCodesRepository.count({
      where: { is_used: true },
    });
    const expired = await this.purchaseCodesRepository.count({
      where: { is_used: false, expires_at: MoreThan(now) },
    });

    return {
      total,
      used,
      unused: total - used,
      expired: total - used - expired,
    };
  }
}
