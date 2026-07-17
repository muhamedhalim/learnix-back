import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { EntityManager, IsNull, Repository } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import {
  CreateDiscountCodeDto,
  DiscountFilterDto,
  UpdateDiscountCodeDto,
  VerificationResult,
  VerifyDiscountCodeDto,
} from './dto';
import { DiscountCode, DiscountCodeUsage, DiscountType } from './entities';

@Injectable()
export class DiscountCodesService {
  private readonly logger = new Logger(DiscountCodesService.name);

  constructor(
    @InjectRepository(DiscountCode)
    private readonly discountCodesRepository: Repository<DiscountCode>,
    @InjectRepository(DiscountCodeUsage)
    private readonly usageRepository: Repository<DiscountCodeUsage>,
  ) {}

  /**
   * Create a new discount code (admin only)
   */
  public async create(dto: CreateDiscountCodeDto): Promise<DiscountCode> {
    // Check for duplicate code
    const existing = await this.discountCodesRepository.findOne({
      where: { code: dto.code.toUpperCase() },
      withDeleted: true,
    });

    if (existing) {
      throw new ConflictException(biBody('Discount code already exists', 'كود الخصم موجود بالفعل'));
    }

    // Validate dates
    const validFrom = new Date(dto.valid_from);
    const validUntil = new Date(dto.valid_until);

    if (validUntil <= validFrom) {
      throw new BadRequestException(
        biBody(
          'valid_until must be after valid_from',
          'يجب أن يكون تاريخ الانتهاء بعد تاريخ البدء',
        ),
      );
    }

    const discountCode = this.discountCodesRepository.create({
      code: dto.code.toUpperCase(),
      discount_type: dto.discount_type,
      discount_value: dto.discount_value,
      applicable_to: dto.applicable_to,
      item_ids: dto.item_ids ?? null,
      max_uses: dto.max_uses ?? 1,
      min_purchase_amount: dto.min_purchase_amount ?? 0,
      valid_from: validFrom,
      valid_until: validUntil,
      is_active: dto.is_active ?? true,
      description: dto.description ?? null,
    });

    const saved = await this.discountCodesRepository.save(discountCode);
    this.logger.log(`Created discount code: ${saved.code}`);
    return saved;
  }

  /**
   * Update a discount code (admin only)
   */
  public async update(id: string, dto: UpdateDiscountCodeDto): Promise<DiscountCode> {
    const discountCode = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
    });

    if (!discountCode) {
      throw new NotFoundException(biBody('Discount code not found', 'كود الخصم غير موجود'));
    }

    // Validate dates if provided
    this.validateDateRange(dto, discountCode);

    // Apply updates
    this.applyDiscountCodeUpdates(discountCode, dto);

    const updated = await this.discountCodesRepository.save(discountCode);
    this.logger.log(`Updated discount code: ${updated.code}`);
    return updated;
  }

  /**
   * Validate date range for discount code updates
   */
  private validateDateRange(dto: UpdateDiscountCodeDto, discountCode: DiscountCode): void {
    if (dto.valid_from !== undefined || dto.valid_until !== undefined) {
      const validFrom =
        dto.valid_from === undefined ? discountCode.valid_from : new Date(dto.valid_from);
      const validUntil =
        dto.valid_until === undefined ? discountCode.valid_until : new Date(dto.valid_until);

      if (validUntil <= validFrom) {
        throw new BadRequestException(
          biBody(
            'valid_until must be after valid_from',
            'يجب أن يكون تاريخ الانتهاء بعد تاريخ البدء',
          ),
        );
      }
    }
  }

  /**
   * Apply DTO updates to discount code entity
   */
  private applyDiscountCodeUpdates(discountCode: DiscountCode, dto: UpdateDiscountCodeDto): void {
    const updates: Partial<DiscountCode> = {};

    if (dto.discount_type !== undefined) {
      updates.discount_type = dto.discount_type;
    }
    if (dto.discount_value !== undefined) {
      updates.discount_value = dto.discount_value;
    }
    if (dto.applicable_to !== undefined) {
      updates.applicable_to = dto.applicable_to;
    }
    if (dto.item_ids !== undefined) {
      updates.item_ids = dto.item_ids;
    }
    if (dto.max_uses !== undefined) {
      updates.max_uses = dto.max_uses;
    }
    if (dto.min_purchase_amount !== undefined) {
      updates.min_purchase_amount = dto.min_purchase_amount;
    }
    if (dto.valid_from !== undefined) {
      updates.valid_from = new Date(dto.valid_from);
    }
    if (dto.valid_until !== undefined) {
      updates.valid_until = new Date(dto.valid_until);
    }
    if (dto.is_active !== undefined) {
      updates.is_active = dto.is_active;
    }
    if (dto.description !== undefined) {
      updates.description = dto.description;
    }

    Object.assign(discountCode, updates);
  }

  /**
   * Soft delete a discount code (admin only)
   */
  public async remove(id: string): Promise<void> {
    const discountCode = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
    });

    if (!discountCode) {
      throw new NotFoundException(biBody('Discount code not found', 'كود الخصم غير موجود'));
    }

    await this.discountCodesRepository.softDelete(id);
    this.logger.log(`Soft deleted discount code: ${discountCode.code}`);
  }

  /**
   * Find all discount codes with filters (admin only)
   */
  public async findAll(
    filter: DiscountFilterDto,
  ): Promise<{ data: DiscountCode[]; meta: PaginationMeta }> {
    const { page, limit } = filter;
    const skip = (page - 1) * limit;

    const queryBuilder = this.discountCodesRepository
      .createQueryBuilder('code')
      .where('code.deleted_at IS NULL');

    if (filter.is_active !== undefined) {
      queryBuilder.andWhere('code.is_active = :isActive', {
        isActive: filter.is_active,
      });
    }

    if (filter.discount_type !== undefined) {
      queryBuilder.andWhere('code.discount_type = :type', {
        type: filter.discount_type,
      });
    }

    if (filter.include_expired !== true) {
      queryBuilder.andWhere('code.valid_until >= :now', { now: new Date() });
    }

    if (filter.valid_from !== undefined) {
      queryBuilder.andWhere('code.valid_from >= :validFrom', {
        validFrom: new Date(filter.valid_from),
      });
    }

    if (filter.valid_until !== undefined) {
      queryBuilder.andWhere('code.valid_until <= :validUntil', {
        validUntil: new Date(filter.valid_until),
      });
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
   * Find one discount code by ID (admin only)
   */
  public async findOne(id: string): Promise<DiscountCode> {
    const discountCode = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
      relations: ['usages', 'usages.user'],
    });

    if (!discountCode) {
      throw new NotFoundException(biBody('Discount code not found', 'كود الخصم غير موجود'));
    }

    return discountCode;
  }

  /**
   * Find discount code by code string
   */
  public async findByCode(code: string): Promise<DiscountCode | null> {
    return await this.discountCodesRepository.findOne({
      where: { code: code.toUpperCase(), deleted_at: IsNull() },
    });
  }

  /**
   * Verify a discount code (public endpoint)
   * Checks validity, usage limits, and applicability
   */
  public async verifyCode(dto: VerifyDiscountCodeDto, userId: string): Promise<VerificationResult> {
    const code = await this.discountCodesRepository.findOne({
      where: {
        code: dto.code.toUpperCase(),
        is_active: true,
        deleted_at: IsNull(),
      },
    });

    if (!code) {
      return { valid: false, error: 'Discount code not found or inactive' };
    }

    // Check validity dates
    const now = new Date();
    if (now < code.valid_from) {
      return { valid: false, error: 'Discount code is not yet valid' };
    }
    if (now > code.valid_until) {
      return { valid: false, error: 'Discount code has expired' };
    }

    // Check usage limits
    if (code.used_count >= code.max_uses) {
      return { valid: false, error: 'Discount code usage limit reached' };
    }

    // Check if user already used this code
    const existingUsage = await this.usageRepository.findOne({
      where: {
        discount_code_id: code.id,
        user_id: userId,
      },
    });

    if (existingUsage) {
      return {
        valid: false,
        error: 'You have already used this discount code',
      };
    }

    // Check applicable items
    if (!code.applicable_to.includes(dto.item_type)) {
      return {
        valid: false,
        error: `Discount code not applicable to ${dto.item_type}s`,
      };
    }

    // Check specific items (if set)
    if (code.item_ids && code.item_ids.length > 0) {
      if (!code.item_ids.includes(dto.item_id)) {
        return {
          valid: false,
          error: 'Discount code not applicable to this item',
        };
      }
    }

    // Check minimum purchase amount
    const minAmount =
      typeof code.min_purchase_amount === 'string'
        ? Number.parseFloat(code.min_purchase_amount)
        : code.min_purchase_amount;
    if (dto.amount < minAmount) {
      return {
        valid: false,
        error: `Minimum purchase amount is ${String(minAmount)} EGP`,
      };
    }

    // Calculate discount
    let discountAmount = 0;
    const discountValue =
      typeof code.discount_value === 'string'
        ? Number.parseFloat(code.discount_value)
        : code.discount_value;
    if (code.discount_type === DiscountType.PERCENTAGE) {
      discountAmount = (dto.amount * discountValue) / 100;
    } else {
      discountAmount = discountValue;
    }

    // Ensure discount doesn't exceed item price
    discountAmount = Math.min(discountAmount, dto.amount);

    return {
      valid: true,
      discount_code_id: code.id,
      discount_type: code.discount_type,
      discount_value: discountValue,
      discount_amount: discountAmount,
      final_amount: dto.amount - discountAmount,
    };
  }

  /**
   * Apply discount code to a payment (with race condition protection)
   * Uses pessimistic locking to prevent double redemption
   */
  public async applyDiscount(
    discountCodeId: string,
    userId: string,
    paymentId: string,
    discountAmount: number,
    manager: EntityManager,
  ): Promise<void> {
    // Lock the discount code row for update
    const code = await manager.findOne(DiscountCode, {
      where: { id: discountCodeId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!code) {
      throw new NotFoundException(biBody('Discount code not found', 'كود الخصم غير موجود'));
    }

    // Double-check usage limit with lock held
    if (code.used_count >= code.max_uses) {
      throw new BadRequestException(
        biBody('Discount code usage limit reached', 'تم الوصول إلى الحد الأقصى لاستخدام كود الخصم'),
      );
    }

    // Increment usage counter
    code.used_count += 1;
    await manager.save(DiscountCode, code);

    // Record usage (unique constraint prevents duplicates)
    try {
      const usage = manager.create(DiscountCodeUsage, {
        discount_code_id: discountCodeId,
        user_id: userId,
        payment_id: paymentId,
        discount_amount: discountAmount,
      });
      await manager.save(DiscountCodeUsage, usage);
    } catch (error: unknown) {
      // Handle unique constraint violation
      if (error instanceof Error && error.message.includes('duplicate key value')) {
        throw new ConflictException(
          biBody('You have already used this discount code', 'لقد استخدمت هذا الكود من قبل'),
        );
      }
      throw error;
    }

    this.logger.log(`Applied discount code ${code.code} for user ${userId}, payment ${paymentId}`);
  }

  /**
   * Undo a discount redemption whose payment never completed (FAILED or
   * EXPIRED). Usage is recorded at initiation so the counter is race-safe, but
   * without this release an abandoned checkout would permanently burn the
   * user's one allowed use (and one global use) on a payment that charged
   * nothing. Runs inside the caller's payment-transition transaction; the code
   * row is locked so the decrement serializes with concurrent applyDiscount
   * calls. Deliberately NOT called for REFUNDED payments: a refunded order did
   * complete once, and re-allowing the code after a refund is a product
   * decision, not an error-path repair.
   */
  public async releaseUsageForPayment(paymentId: string, manager: EntityManager): Promise<void> {
    const usages = await manager.find(DiscountCodeUsage, {
      where: { payment_id: paymentId },
    });

    for (const usage of usages) {
      const code = await manager.findOne(DiscountCode, {
        where: { id: usage.discount_code_id },
        lock: { mode: 'pessimistic_write' },
      });

      await manager.delete(DiscountCodeUsage, { id: usage.id });

      if (code !== null && code.used_count > 0) {
        code.used_count -= 1;
        await manager.save(DiscountCode, code);
      }

      this.logger.log(
        `Released discount usage for payment ${paymentId} (code ${usage.discount_code_id})`,
      );
    }
  }

  /**
   * Get usage statistics for a discount code
   */
  public async getUsageStats(id: string): Promise<{
    total_uses: number;
    remaining_uses: number;
    total_discount_given: number;
    users: Array<{ user_id: string; used_at: Date; discount_amount: number }>;
  }> {
    const code = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
    });

    if (!code) {
      throw new NotFoundException(biBody('Discount code not found', 'كود الخصم غير موجود'));
    }

    const usages = await this.usageRepository.find({
      where: { discount_code_id: id },
      relations: ['user'],
      order: { used_at: 'DESC' },
    });

    const totalDiscountGiven = usages.reduce((sum, u) => {
      const amount =
        typeof u.discount_amount === 'string'
          ? Number.parseFloat(u.discount_amount)
          : u.discount_amount;
      return sum + amount;
    }, 0);

    return {
      total_uses: code.used_count,
      remaining_uses: code.max_uses - code.used_count,
      total_discount_given: totalDiscountGiven,
      users: usages.map((u) => {
        const amount =
          typeof u.discount_amount === 'string'
            ? Number.parseFloat(u.discount_amount)
            : u.discount_amount;
        return {
          user_id: u.user_id,
          used_at: u.used_at,
          discount_amount: amount,
        };
      }),
    };
  }
}
