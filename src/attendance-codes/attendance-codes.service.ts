import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { computeAccessExpiresAt } from '../common/utils/lesson-access.util';
import { retryTransaction } from '../common/utils/transaction-retry.util';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import {
  ItemType,
  LessonPurchase,
  PackagePurchase,
  Payment,
  PaymentMethod,
  PaymentStatus,
} from '../payments/entities';
import {
  AttendanceCodeFilterDto,
  GenerateAttendanceCodesDto,
  UpdateAttendanceCodeDto,
  VerifyAttendanceCodeDto,
} from './dto';
import { generateAttendanceCode } from './code-generator.util';
import {
  AttendanceCode,
  AttendanceCodeAudit,
  AttendanceCodeAuditAction,
  AttendanceCodeStatus,
  AttendanceCodeType,
} from './entities';

@Injectable()
export class AttendanceCodesService {
  private readonly logger = new Logger(AttendanceCodesService.name);

  constructor(
    @InjectRepository(AttendanceCode)
    private readonly attendanceCodesRepository: Repository<AttendanceCode>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Generate cryptographically secure purchase codes
   */
  public async generateCodes(
    dto: GenerateAttendanceCodesDto,
    adminId: string,
  ): Promise<AttendanceCode[]> {
    // Validate item exists
    if (dto.type === AttendanceCodeType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: dto.item_id, deleted_at: IsNull() },
      });
      if (!lesson) {
        throw new NotFoundException('Lesson not found');
      }
    } else if (dto.type === AttendanceCodeType.PACKAGE) {
      const pkg = await this.packagesRepository.findOne({
        where: { id: dto.item_id, deleted_at: IsNull() },
      });
      if (!pkg) {
        throw new NotFoundException('Package not found');
      }
    }

    const codes: AttendanceCode[] = [];
    const expiresAt = new Date(dto.expires_at);

    for (let i = 0; i < dto.count; i++) {
      const code = this.generateUniqueCode();

      const attendanceCode = this.attendanceCodesRepository.create({
        code,
        type: dto.type,
        item_id: dto.item_id,
        expires_at: expiresAt,
        created_by: adminId,
      });

      codes.push(attendanceCode);
    }

    const savedCodes = await this.attendanceCodesRepository.save(codes);
    this.logger.log(
      `Generated ${String(dto.count)} purchase codes for ${dto.type} ${dto.item_id} by admin ${adminId}`,
    );

    return savedCodes;
  }

  /** Generate a unique 8-character alphanumeric code (shared generator). */
  private generateUniqueCode(): string {
    return generateAttendanceCode();
  }

  /**
   * Verify code validity without redeeming (public endpoint)
   * Returns code details for display to user before redemption
   */
  public async verifyCodePublic(code: string): Promise<{
    valid: boolean;
    itemType?: 'lesson' | 'package' | 'book' | undefined;
    itemId?: string | undefined;
    itemTitle?: string | undefined;
    price?: number | undefined;
    expiresAt?: Date | undefined;
    isExpired?: boolean | undefined;
    isUsed?: boolean | undefined;
  }> {
    // Find code (no lock needed for read-only operation)
    const attendanceCode = await this.attendanceCodesRepository.findOne({
      where: {
        code: code.toUpperCase(),
      },
    });

    if (!attendanceCode) {
      return { valid: false };
    }

    const now = new Date();
    const isExpired = attendanceCode.expires_at < now;
    const isUsed = attendanceCode.is_used;

    // Fetch item details
    let itemTitle: string | undefined;
    let price: number | undefined;

    if (attendanceCode.type === AttendanceCodeType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: attendanceCode.item_id, deleted_at: IsNull() },
      });
      itemTitle = lesson?.title;
      price = lesson?.price;
    } else if (attendanceCode.type === AttendanceCodeType.PACKAGE) {
      const pkg = await this.packagesRepository.findOne({
        where: { id: attendanceCode.item_id, deleted_at: IsNull() },
      });
      itemTitle = pkg?.title;
      price = pkg?.price;
    }

    // Code is valid if: exists, not used, not expired, and item still exists
    const valid = !isUsed && !isExpired && itemTitle !== undefined && itemTitle !== '';

    return {
      valid,
      itemType: attendanceCode.type,
      itemId: attendanceCode.item_id,
      itemTitle,
      price,
      expiresAt: attendanceCode.expires_at,
      isExpired,
      isUsed,
    };
  }

  /**
   * Verify and redeem a purchase code (with race condition protection)
   */
  public async verifyAndRedeem(dto: VerifyAttendanceCodeDto, userId: string): Promise<Payment> {
    return await retryTransaction(this.dataSource, async (manager) => {
      // Find unused, unexpired, active code with pessimistic lock
      const code = await manager.findOne(AttendanceCode, {
        where: {
          code: dto.code.toUpperCase(),
          is_used: false,
          is_active: true,
          expires_at: MoreThan(new Date()),
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (!code) {
        throw new NotFoundException('Invalid, expired, or deactivated purchase code');
      }

      // Mark as used (canonical lifecycle → REDEEMED) and record the audit.
      code.is_used = true;
      code.status = AttendanceCodeStatus.REDEEMED;
      code.used_by = userId;
      code.used_at = new Date();
      await manager.save(AttendanceCode, code);
      await manager.insert(AttendanceCodeAudit, {
        code_id: code.id,
        batch_id: code.batch_id,
        action: AttendanceCodeAuditAction.REDEEMED,
        actor_id: userId,
        metadata: { code: code.code, type: code.type, item_id: code.item_id },
      });

      // Create free payment
      const itemType =
        code.type === AttendanceCodeType.LESSON
          ? ItemType.LESSON
          : code.type === AttendanceCodeType.PACKAGE
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
      if (code.type === AttendanceCodeType.LESSON) {
        await this.grantLessonAccess(manager, savedPayment, code.item_id);
      } else if (code.type === AttendanceCodeType.PACKAGE) {
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

    const accessDays = lesson?.available_for_days ?? 7;
    const accessGrantedAt = new Date();
    const accessExpiresAt = computeAccessExpiresAt(accessGrantedAt, accessDays);

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
      const { lesson } = item;

      const accessDays = lesson.available_for_days === 0 ? 7 : lesson.available_for_days;
      const accessGrantedAt = new Date();
      const accessExpiresAt = computeAccessExpiresAt(accessGrantedAt, accessDays);

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
  public async findAll(
    filter: AttendanceCodeFilterDto,
  ): Promise<{ data: AttendanceCode[]; meta: PaginationMeta }> {
    const page = filter.page === 0 ? 1 : filter.page;
    const limit = filter.limit === 0 ? 20 : filter.limit;
    const skip = (page - 1) * limit;

    const queryBuilder = this.attendanceCodesRepository
      .createQueryBuilder('code')
      .leftJoinAndSelect('code.user', 'user')
      .leftJoinAndSelect('code.creator', 'creator');

    if (filter.is_used !== undefined) {
      queryBuilder.andWhere('code.is_used = :isUsed', {
        isUsed: filter.is_used,
      });
    }

    if (typeof filter.type === 'string') {
      queryBuilder.andWhere('code.type = :type', { type: filter.type });
    }

    if (typeof filter.item_id === 'string' && filter.item_id !== '') {
      queryBuilder.andWhere('code.item_id = :itemId', {
        itemId: filter.item_id,
      });
    }

    if (filter.include_expired !== true) {
      queryBuilder.andWhere('code.expires_at > :now', { now: new Date() });
    }

    queryBuilder.orderBy('code.created_at', 'DESC');

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
   * Find a purchase code by code string
   */
  public async findByCode(code: string): Promise<AttendanceCode | null> {
    return await this.attendanceCodesRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['user', 'creator'],
    });
  }

  /**
   * Update a purchase code (admin only)
   * Only allows updating expiration date
   */
  public async updateCode(code: string, dto: UpdateAttendanceCodeDto): Promise<AttendanceCode> {
    const attendanceCode = await this.attendanceCodesRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['user', 'creator'],
    });

    if (!attendanceCode) {
      throw new NotFoundException('Purchase code not found');
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException('Cannot update a used purchase code');
    }

    if (!attendanceCode.is_active) {
      throw new BadRequestException('Cannot update a deactivated purchase code');
    }

    // Update expiration date if provided
    if (typeof dto.expires_at === 'string') {
      const newExpiresAt = new Date(dto.expires_at);
      if (newExpiresAt <= new Date()) {
        throw new BadRequestException('Expiration date must be in the future');
      }
      attendanceCode.expires_at = newExpiresAt;
    }

    const updatedCode = await this.attendanceCodesRepository.save(attendanceCode);
    this.logger.log(`Updated purchase code: ${code}`);

    return updatedCode;
  }

  /**
   * Deactivate a purchase code (admin only)
   * Makes the code unusable without deleting it
   */
  public async deactivateCode(code: string): Promise<AttendanceCode> {
    const attendanceCode = await this.attendanceCodesRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['user', 'creator'],
    });

    if (!attendanceCode) {
      throw new NotFoundException('Purchase code not found');
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException('Cannot deactivate a used purchase code');
    }

    if (!attendanceCode.is_active) {
      throw new BadRequestException('Purchase code is already deactivated');
    }

    attendanceCode.is_active = false;
    const updatedCode = await this.attendanceCodesRepository.save(attendanceCode);
    this.logger.log(`Deactivated purchase code: ${code}`);

    return updatedCode;
  }

  /**
   * Reactivate a deactivated purchase code (admin only)
   */
  public async reactivateCode(code: string): Promise<AttendanceCode> {
    const attendanceCode = await this.attendanceCodesRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['user', 'creator'],
    });

    if (!attendanceCode) {
      throw new NotFoundException('Purchase code not found');
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException('Cannot reactivate a used purchase code');
    }

    if (attendanceCode.is_active) {
      throw new BadRequestException('Purchase code is already active');
    }

    // Check if code is expired
    if (attendanceCode.expires_at < new Date()) {
      throw new BadRequestException(
        'Cannot reactivate an expired code. Update the expiration date first.',
      );
    }

    attendanceCode.is_active = true;
    const updatedCode = await this.attendanceCodesRepository.save(attendanceCode);
    this.logger.log(`Reactivated purchase code: ${code}`);

    return updatedCode;
  }

  /**
   * Get usage history for a specific code (admin only)
   * Returns the student who used the code and purchase details
   */
  public async getCodeUsage(code: string): Promise<{
    code: string;
    type: AttendanceCodeType;
    item_id: string;
    is_used: boolean;
    is_active: boolean;
    expires_at: Date;
    created_at: Date;
    usage: {
      used_by: string | null;
      user_name: string | null;
      user_email: string | null;
      used_at: Date | null;
    } | null;
  }> {
    const attendanceCode = await this.attendanceCodesRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['user'],
    });

    if (!attendanceCode) {
      throw new NotFoundException('Purchase code not found');
    }

    return {
      code: attendanceCode.code,
      type: attendanceCode.type,
      item_id: attendanceCode.item_id,
      is_used: attendanceCode.is_used,
      is_active: attendanceCode.is_active,
      expires_at: attendanceCode.expires_at,
      created_at: attendanceCode.created_at,
      usage: attendanceCode.is_used
        ? {
            used_by: attendanceCode.used_by,
            user_name: attendanceCode.user?.name ?? null,
            user_email: attendanceCode.user?.email ?? null,
            used_at: attendanceCode.used_at,
          }
        : null,
    };
  }

  /**
   * Delete an unused purchase code (admin only)
   */
  public async remove(code: string): Promise<void> {
    const attendanceCode = await this.attendanceCodesRepository.findOne({
      where: { code: code.toUpperCase() },
    });

    if (!attendanceCode) {
      throw new NotFoundException('Purchase code not found');
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException('Cannot delete a used purchase code');
    }

    await this.attendanceCodesRepository.remove(attendanceCode);
    this.logger.log(`Deleted purchase code: ${code}`);
  }

  /**
   * Get statistics for purchase codes
   */
  public async getStats(): Promise<{
    total: number;
    used: number;
    unused: number;
    expired: number;
  }> {
    const now = new Date();

    const total = await this.attendanceCodesRepository.count();
    const used = await this.attendanceCodesRepository.count({
      where: { is_used: true },
    });
    const expired = await this.attendanceCodesRepository.count({
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
