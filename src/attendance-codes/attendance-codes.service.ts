import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';

import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { retryTransaction } from '../common/utils/transaction-retry.util';
import { biBody } from '../i18n/error-translator.util';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { User } from '../users/entities/user.entity';
import { CollectionParty, LessonPurchase, PackagePurchase, Payment } from '../payments/entities';
import { toMinorUnits } from '../payments/money.util';
import { CommissionService } from '../payments/services/commission.service';
import { OrdersService } from '../payments/services/orders.service';
import { PaymentFinalizationService } from '../payments/services/payment-finalization.service';
import {
  AttendanceCodeFilterDto,
  GenerateAttendanceCodesDto,
  UpdateAttendanceCodeDto,
  VerifyAttendanceCodeDto,
} from './dto';
import {
  generateAttendanceCode,
  hashAttendanceCode,
  normalizeAttendanceCode,
} from './code-generator.util';
import { AttendanceCode, AttendanceCodeStatus, AttendanceCodeType } from './entities';

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
    @InjectRepository(Book)
    private readonly booksRepository: Repository<Book>,
    private readonly dataSource: DataSource,
    private readonly ordersService: OrdersService,
    private readonly finalizer: PaymentFinalizationService,
    private readonly commissions: CommissionService,
  ) {}

  /**
   * Generate cryptographically secure purchase codes
   */
  public async generateCodes(
    dto: GenerateAttendanceCodesDto,
    adminId: string,
  ): Promise<AttendanceCode[]> {
    let teacherId: string;
    let faceValueMinor: number;

    // Validate item exists and capture immutable financial ownership.
    if (dto.type === AttendanceCodeType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: dto.item_id, deleted_at: IsNull() },
      });
      if (!lesson) {
        throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
      }
      this.assertGroupLessonCodeTarget(lesson);
      teacherId = lesson.teacher_id;
      faceValueMinor = toMinorUnits(lesson.price);
    } else if (dto.type === AttendanceCodeType.PACKAGE) {
      const pkg = await this.packagesRepository.findOne({
        where: { id: dto.item_id, deleted_at: IsNull() },
      });
      if (!pkg) {
        throw new NotFoundException(biBody('Package not found', 'الباقة غير موجودة'));
      }
      teacherId = pkg.teacher_id;
      faceValueMinor = toMinorUnits(pkg.price);
    } else {
      const book = await this.booksRepository.findOne({
        where: { id: dto.item_id, deleted_at: IsNull() },
      });
      if (!book) {
        throw new NotFoundException(biBody('Book not found', 'الكتاب غير موجود'));
      }
      teacherId = book.teacher_id;
      faceValueMinor = toMinorUnits(book.price);
    }

    const codes: AttendanceCode[] = [];
    const expiresAt = new Date(dto.expires_at);

    for (let i = 0; i < dto.count; i++) {
      const code = this.generateUniqueCode();

      const attendanceCode = this.attendanceCodesRepository.create({
        code,
        lookup_hash: hashAttendanceCode(code),
        type: dto.type,
        item_id: dto.item_id,
        teacher_id: teacherId,
        face_value_minor: faceValueMinor,
        platform_commission_bps: this.commissions.resolveRate(),
        currency: 'EGP',
        valid_from: new Date(),
        maximum_redemptions: 1,
        redemption_count: 0,
        collection_party: CollectionParty.PLATFORM,
        assigned_party: null,
        assigned_student_id: null,
        redeemed_order_id: null,
        metadata: { generated_via: 'legacy_admin_endpoint' },
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
    teacherName?: string | undefined;
    codeType?: 'lesson' | 'package' | 'book' | undefined;
    accessDurationDays?: number | null | undefined;
    price?: number | undefined;
    expiresAt?: Date | undefined;
    isExpired?: boolean | undefined;
    isUsed?: boolean | undefined;
  }> {
    // Find code (no lock needed for read-only operation)
    const normalized = normalizeAttendanceCode(code);
    const attendanceCode = await this.attendanceCodesRepository
      .createQueryBuilder('code')
      .where('code.lookup_hash = :hash', { hash: hashAttendanceCode(normalized) })
      .orWhere('(code.lookup_hash IS NULL AND code.code = :normalized)', { normalized })
      .getOne();

    if (!attendanceCode) {
      return { valid: false };
    }

    const now = new Date();
    const isExpired = attendanceCode.expires_at < now;
    const isUsed = attendanceCode.is_used;

    // Fetch item details
    let itemTitle: string | undefined;
    let price: number | undefined;
    let accessDurationDays: number | null = null;

    if (attendanceCode.type === AttendanceCodeType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: attendanceCode.item_id, deleted_at: IsNull() },
      });
      if (
        lesson &&
        !attendanceCode.is_used &&
        attendanceCode.status !== AttendanceCodeStatus.REDEEMED
      ) {
        this.assertGroupLessonCodeTarget(lesson);
      }
      itemTitle = lesson?.title;
      accessDurationDays = lesson?.available_for_days ?? null;
      price =
        attendanceCode.face_value_minor === null
          ? lesson?.price
          : attendanceCode.face_value_minor / 100;
    } else if (attendanceCode.type === AttendanceCodeType.PACKAGE) {
      const pkg = await this.packagesRepository.findOne({
        where: { id: attendanceCode.item_id, deleted_at: IsNull() },
      });
      itemTitle = pkg?.title;
      price =
        attendanceCode.face_value_minor === null
          ? pkg?.price
          : attendanceCode.face_value_minor / 100;
    } else {
      const book = await this.booksRepository.findOne({
        where: { id: attendanceCode.item_id, deleted_at: IsNull() },
      });
      itemTitle = book?.title;
      price =
        attendanceCode.face_value_minor === null
          ? book?.price
          : attendanceCode.face_value_minor / 100;
    }

    const teacher = attendanceCode.teacher_id
      ? await this.dataSource.getRepository(User).findOne({
          where: { id: attendanceCode.teacher_id, is_active: true },
        })
      : null;

    // Code is valid if: exists, not used, not expired, and item still exists
    const valid =
      !isUsed &&
      !isExpired &&
      attendanceCode.is_active &&
      attendanceCode.status !== AttendanceCodeStatus.REVOKED &&
      attendanceCode.status !== AttendanceCodeStatus.REDEEMED &&
      (attendanceCode.valid_from === null || attendanceCode.valid_from <= now) &&
      attendanceCode.redemption_count < attendanceCode.maximum_redemptions &&
      itemTitle !== undefined &&
      itemTitle !== '';

    return {
      valid,
      itemType: attendanceCode.type,
      itemId: attendanceCode.item_id,
      itemTitle,
      teacherName: teacher?.name,
      codeType: attendanceCode.type,
      accessDurationDays,
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
    return retryTransaction(this.dataSource, async (manager) => {
      const normalized = normalizeAttendanceCode(dto.code);
      const code = await manager
        .getRepository(AttendanceCode)
        .createQueryBuilder('code')
        .setLock('pessimistic_write')
        .where('code.lookup_hash = :hash', {
          hash: hashAttendanceCode(normalized),
        })
        .orWhere('(code.lookup_hash IS NULL AND code.code = :normalized)', {
          normalized,
        })
        .getOne();
      const now = new Date();
      if (
        !code ||
        code.is_used ||
        !code.is_active ||
        code.status === AttendanceCodeStatus.REDEEMED ||
        code.status === AttendanceCodeStatus.REVOKED ||
        code.expires_at <= now ||
        (code.valid_from !== null && code.valid_from > now) ||
        code.redemption_count >= code.maximum_redemptions ||
        (code.assigned_student_id !== null && code.assigned_student_id !== userId)
      ) {
        throw new NotFoundException(
          biBody(
            'Invalid, expired, or deactivated activation code',
            'رمز التفعيل غير صالح أو منتهي أو معطل',
          ),
        );
      }
      if (code.type === AttendanceCodeType.LESSON) {
        const lesson = await manager.findOne(Lesson, {
          where: { id: code.item_id, deleted_at: IsNull() },
        });
        if (!lesson) {
          throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
        }
        this.assertGroupLessonCodeTarget(lesson);
      }
      await this.assertNotAlreadyOwned(manager, userId, code.type, code.item_id);
      const { order, payment } = await this.ordersService.createActivationCodeOrder(
        manager,
        code,
        userId,
      );
      await this.finalizer.finalizeSuccessfulPayment(
        {
          orderId: order.id,
          paymentId: payment.id,
          sourceReference: `activation-code-${code.id}`,
          actorId: userId,
          activationCodeId: code.id,
          verifiedAmountMinor: order.final_amount_minor,
          verifiedCurrency: order.currency,
        },
        manager,
      );
      return payment;
    });
  }

  /**
   * Reject redemption when the student already has (still-active) access to
   * the code's item, so the single-use code survives for a rightful use.
   */
  private async assertNotAlreadyOwned(
    manager: ReturnType<DataSource['createEntityManager']>,
    userId: string,
    type: AttendanceCodeType,
    itemId: string,
  ): Promise<void> {
    let alreadyOwned = false;

    if (type === AttendanceCodeType.LESSON) {
      alreadyOwned =
        (await manager.findOne(LessonPurchase, {
          where: {
            student_id: userId,
            lesson_id: itemId,
            access_expires_at: MoreThan(new Date()),
          },
        })) !== null;
    } else if (type === AttendanceCodeType.PACKAGE) {
      alreadyOwned =
        (await manager.findOne(PackagePurchase, {
          where: { student_id: userId, package_id: itemId },
        })) !== null;
    } else {
      alreadyOwned =
        (await manager.findOne(BookPurchase, {
          where: { student_id: userId, book_id: itemId },
        })) !== null;
    }

    if (alreadyOwned) {
      throw new ConflictException(
        biBody(
          'You already have access to this item — the code was not consumed',
          'لديك بالفعل صلاحية الوصول إلى هذا العنصر — لم يتم استهلاك الرمز',
        ),
      );
    }
  }

  private assertGroupLessonCodeTarget(lesson: Pick<Lesson, 'is_group'>): void {
    if (lesson.is_group === false) {
      throw new BadRequestException(
        biBody(
          'Activation codes cannot be used for Individual lessons. Choose an appointment instead.',
          'لا يمكن استخدام رموز التفعيل للدروس الفردية. اختر موعدًا بدلًا من ذلك.',
        ),
      );
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

    const search = filter.search?.trim();
    if (search) {
      queryBuilder.andWhere('code.code ILIKE :search', { search: `%${search}%` });
    }

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
      throw new NotFoundException(biBody('Purchase code not found', 'رمز الشراء غير موجود'));
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException(
        biBody('Cannot update a used purchase code', 'لا يمكن تعديل رمز شراء تم استخدامه بالفعل'),
      );
    }

    if (!attendanceCode.is_active) {
      throw new BadRequestException(
        biBody('Cannot update a deactivated purchase code', 'لا يمكن تعديل رمز شراء تم تعطيله'),
      );
    }

    // Update expiration date if provided
    if (typeof dto.expires_at === 'string') {
      const newExpiresAt = new Date(dto.expires_at);
      if (newExpiresAt <= new Date()) {
        throw new BadRequestException(
          biBody('Expiration date must be in the future', 'يجب أن يكون تاريخ الانتهاء في المستقبل'),
        );
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
      throw new NotFoundException(biBody('Purchase code not found', 'رمز الشراء غير موجود'));
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException(
        biBody(
          'Cannot deactivate a used purchase code',
          'لا يمكن تعطيل رمز شراء تم استخدامه بالفعل',
        ),
      );
    }

    if (!attendanceCode.is_active) {
      throw new BadRequestException(
        biBody('Purchase code is already deactivated', 'رمز الشراء معطل بالفعل'),
      );
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
      throw new NotFoundException(biBody('Purchase code not found', 'رمز الشراء غير موجود'));
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException(
        biBody(
          'Cannot reactivate a used purchase code',
          'لا يمكن إعادة تفعيل رمز شراء تم استخدامه بالفعل',
        ),
      );
    }

    if (attendanceCode.is_active) {
      throw new BadRequestException(
        biBody('Purchase code is already active', 'رمز الشراء مفعّل بالفعل'),
      );
    }

    // Check if code is expired
    if (attendanceCode.expires_at < new Date()) {
      throw new BadRequestException(
        biBody(
          'Cannot reactivate an expired code. Update the expiration date first.',
          'لا يمكن إعادة تفعيل رمز منتهي الصلاحية. يرجى تحديث تاريخ الانتهاء أولاً.',
        ),
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
      throw new NotFoundException(biBody('Purchase code not found', 'رمز الشراء غير موجود'));
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
      throw new NotFoundException(biBody('Purchase code not found', 'رمز الشراء غير موجود'));
    }

    if (attendanceCode.is_used) {
      throw new BadRequestException(
        biBody('Cannot delete a used purchase code', 'لا يمكن حذف رمز شراء تم استخدامه بالفعل'),
      );
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
