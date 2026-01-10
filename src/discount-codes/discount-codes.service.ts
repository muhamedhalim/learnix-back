import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, IsNull } from 'typeorm';
import { DiscountCode, DiscountCodeUsage, DiscountType } from './entities';
import {
  CreateDiscountCodeDto,
  UpdateDiscountCodeDto,
  VerifyDiscountCodeDto,
  VerificationResult,
  DiscountFilterDto,
} from './dto';
import { PaginationMeta } from '../common/interfaces/pagination.interface';

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
  async create(dto: CreateDiscountCodeDto): Promise<DiscountCode> {
    // Check for duplicate code
    const existing = await this.discountCodesRepository.findOne({
      where: { code: dto.code.toUpperCase() },
      withDeleted: true,
    });

    if (existing) {
      throw new ConflictException('Discount code already exists');
    }

    // Validate dates
    const validFrom = new Date(dto.valid_from);
    const validUntil = new Date(dto.valid_until);

    if (validUntil <= validFrom) {
      throw new BadRequestException('valid_until must be after valid_from');
    }

    const discountCode = this.discountCodesRepository.create({
      code: dto.code.toUpperCase(),
      discount_type: dto.discount_type,
      discount_value: dto.discount_value,
      applicable_to: dto.applicable_to,
      item_ids: dto.item_ids || null,
      max_uses: dto.max_uses || 1,
      min_purchase_amount: dto.min_purchase_amount || 0,
      valid_from: validFrom,
      valid_until: validUntil,
      is_active: dto.is_active ?? true,
      description: dto.description || null,
    });

    const saved = await this.discountCodesRepository.save(discountCode);
    this.logger.log(`Created discount code: ${saved.code}`);
    return saved;
  }

  /**
   * Update a discount code (admin only)
   */
  async update(id: string, dto: UpdateDiscountCodeDto): Promise<DiscountCode> {
    const discountCode = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
    });

    if (!discountCode) {
      throw new NotFoundException('Discount code not found');
    }

    // Validate dates if provided
    if (dto.valid_from || dto.valid_until) {
      const validFrom = dto.valid_from
        ? new Date(dto.valid_from)
        : discountCode.valid_from;
      const validUntil = dto.valid_until
        ? new Date(dto.valid_until)
        : discountCode.valid_until;

      if (validUntil <= validFrom) {
        throw new BadRequestException('valid_until must be after valid_from');
      }
    }

    Object.assign(discountCode, {
      ...dto,
      valid_from: dto.valid_from ? new Date(dto.valid_from) : undefined,
      valid_until: dto.valid_until ? new Date(dto.valid_until) : undefined,
    });

    const updated = await this.discountCodesRepository.save(discountCode);
    this.logger.log(`Updated discount code: ${updated.code}`);
    return updated;
  }

  /**
   * Soft delete a discount code (admin only)
   */
  async remove(id: string): Promise<void> {
    const discountCode = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
    });

    if (!discountCode) {
      throw new NotFoundException('Discount code not found');
    }

    await this.discountCodesRepository.softDelete(id);
    this.logger.log(`Soft deleted discount code: ${discountCode.code}`);
  }

  /**
   * Find all discount codes with filters (admin only)
   */
  async findAll(
    filter: DiscountFilterDto,
  ): Promise<{ data: DiscountCode[]; meta: PaginationMeta }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.discountCodesRepository
      .createQueryBuilder('code')
      .where('code.deleted_at IS NULL');

    if (filter.is_active !== undefined) {
      queryBuilder.andWhere('code.is_active = :isActive', {
        isActive: filter.is_active,
      });
    }

    if (filter.discount_type) {
      queryBuilder.andWhere('code.discount_type = :type', {
        type: filter.discount_type,
      });
    }

    if (!filter.include_expired) {
      queryBuilder.andWhere('code.valid_until >= :now', { now: new Date() });
    }

    if (filter.valid_from) {
      queryBuilder.andWhere('code.valid_from >= :validFrom', {
        validFrom: new Date(filter.valid_from),
      });
    }

    if (filter.valid_until) {
      queryBuilder.andWhere('code.valid_until <= :validUntil', {
        validUntil: new Date(filter.valid_until),
      });
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
   * Find one discount code by ID (admin only)
   */
  async findOne(id: string): Promise<DiscountCode> {
    const discountCode = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
      relations: ['usages', 'usages.user'],
    });

    if (!discountCode) {
      throw new NotFoundException('Discount code not found');
    }

    return discountCode;
  }

  /**
   * Find discount code by code string
   */
  async findByCode(code: string): Promise<DiscountCode | null> {
    return await this.discountCodesRepository.findOne({
      where: { code: code.toUpperCase(), deleted_at: IsNull() },
    });
  }

  /**
   * Verify a discount code (public endpoint)
   * Checks validity, usage limits, and applicability
   */
  async verifyCode(
    dto: VerifyDiscountCodeDto,
    userId: string,
  ): Promise<VerificationResult> {
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
    if (dto.amount < Number(code.min_purchase_amount)) {
      return {
        valid: false,
        error: `Minimum purchase amount is ${code.min_purchase_amount} EGP`,
      };
    }

    // Calculate discount
    let discountAmount = 0;
    if (code.discount_type === DiscountType.PERCENTAGE) {
      discountAmount = (dto.amount * Number(code.discount_value)) / 100;
    } else {
      discountAmount = Number(code.discount_value);
    }

    // Ensure discount doesn't exceed item price
    discountAmount = Math.min(discountAmount, dto.amount);

    return {
      valid: true,
      discount_code_id: code.id,
      discount_type: code.discount_type,
      discount_value: Number(code.discount_value),
      discount_amount: discountAmount,
      final_amount: dto.amount - discountAmount,
    };
  }

  /**
   * Apply discount code to a payment (with race condition protection)
   * Uses pessimistic locking to prevent double redemption
   */
  async applyDiscount(
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
      throw new NotFoundException('Discount code not found');
    }

    // Double-check usage limit with lock held
    if (code.used_count >= code.max_uses) {
      throw new BadRequestException('Discount code usage limit reached');
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
      if (
        error instanceof Error &&
        error.message.includes('duplicate key value')
      ) {
        throw new ConflictException('You have already used this discount code');
      }
      throw error;
    }

    this.logger.log(
      `Applied discount code ${code.code} for user ${userId}, payment ${paymentId}`,
    );
  }

  /**
   * Get usage statistics for a discount code
   */
  async getUsageStats(id: string): Promise<{
    total_uses: number;
    remaining_uses: number;
    total_discount_given: number;
    users: { user_id: string; used_at: Date; discount_amount: number }[];
  }> {
    const code = await this.discountCodesRepository.findOne({
      where: { id, deleted_at: IsNull() },
    });

    if (!code) {
      throw new NotFoundException('Discount code not found');
    }

    const usages = await this.usageRepository.find({
      where: { discount_code_id: id },
      relations: ['user'],
      order: { used_at: 'DESC' },
    });

    const totalDiscountGiven = usages.reduce(
      (sum, u) => sum + Number(u.discount_amount),
      0,
    );

    return {
      total_uses: code.used_count,
      remaining_uses: code.max_uses - code.used_count,
      total_discount_given: totalDiscountGiven,
      users: usages.map((u) => ({
        user_id: u.user_id,
        used_at: u.used_at,
        discount_amount: Number(u.discount_amount),
      })),
    };
  }
}
