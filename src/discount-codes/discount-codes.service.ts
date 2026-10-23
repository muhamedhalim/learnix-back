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
import { toMinorUnits } from '../payments/money.util';
import {
  CreateDiscountCodeDto,
  DiscountFilterDto,
  UpdateDiscountCodeDto,
  VerificationResult,
  VerifyDiscountCodeDto,
} from './dto';
import { DiscountCode, DiscountCodeUsage, DiscountType } from './entities';

/** A server-side cart line.  `key` is the immutable cart-item id used for allocation. */
export interface CartDiscountItem {
  key: string;
  item_type: string;
  item_id: string;
  amount_minor: number;
}

export interface CartDiscountQuote {
  discount_code_id: string | null;
  discount_amount_minor: number;
  applicable_subtotal_minor: number;
  allocations_minor: Record<string, number>;
  snapshot: Record<string, unknown> | null;
}

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

    const validFrom = dto.valid_from ? new Date(dto.valid_from) : new Date();
    const validUntil = dto.valid_until ? new Date(dto.valid_until) : null;
    this.assertDateRange(validFrom, validUntil);
    this.assertDiscountRules(dto.discount_type, dto.discount_value, dto.max_discount_amount);
    this.assertUsageLimits(dto.max_uses ?? 1, dto.max_uses_per_user ?? 1);

    const discountCode = this.discountCodesRepository.create({
      code: dto.code.toUpperCase(),
      discount_type: dto.discount_type,
      discount_value: dto.discount_value,
      applicable_to: dto.applicable_to,
      item_ids: dto.item_ids ?? null,
      max_uses: dto.max_uses ?? 1,
      max_uses_per_user: dto.max_uses_per_user ?? 1,
      min_purchase_amount: dto.min_purchase_amount ?? 0,
      max_discount_amount: dto.max_discount_amount ?? null,
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

    this.assertDiscountRules(
      dto.discount_type ?? discountCode.discount_type,
      dto.discount_value ?? Number(discountCode.discount_value),
      dto.max_discount_amount === undefined
        ? discountCode.max_discount_amount
        : dto.max_discount_amount,
    );
    this.assertUsageLimits(
      dto.max_uses ?? discountCode.max_uses,
      dto.max_uses_per_user ?? discountCode.max_uses_per_user,
    );

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
        dto.valid_until === undefined
          ? discountCode.valid_until
          : dto.valid_until
            ? new Date(dto.valid_until)
            : null;
      this.assertDateRange(validFrom, validUntil);
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
    if (dto.max_uses_per_user !== undefined) {
      updates.max_uses_per_user = dto.max_uses_per_user;
    }
    if (dto.min_purchase_amount !== undefined) {
      updates.min_purchase_amount = dto.min_purchase_amount;
    }
    if (dto.max_discount_amount !== undefined) {
      updates.max_discount_amount = dto.max_discount_amount;
    }
    if (dto.valid_from !== undefined) {
      updates.valid_from = new Date(dto.valid_from);
    }
    if (dto.valid_until !== undefined) {
      updates.valid_until = dto.valid_until ? new Date(dto.valid_until) : null;
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

    const search = filter.search?.trim();
    if (search) {
      queryBuilder.andWhere('code.code ILIKE :search', { search: `%${search}%` });
    }

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
      queryBuilder.andWhere('(code.valid_until IS NULL OR code.valid_until >= :now)', {
        now: new Date(),
      });
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
    if (code.valid_until !== null && now > code.valid_until) {
      return { valid: false, error: 'Discount code has expired' };
    }

    const discountValue = Number(code.discount_value);
    const maxDiscount = code.max_discount_amount === null ? null : Number(code.max_discount_amount);
    if (
      !Number.isFinite(dto.amount) ||
      dto.amount <= 0 ||
      !Number.isFinite(discountValue) ||
      discountValue <= 0 ||
      (code.discount_type === DiscountType.PERCENTAGE &&
        (discountValue < 1 || discountValue > 100)) ||
      (maxDiscount !== null && (!Number.isFinite(maxDiscount) || maxDiscount <= 0))
    ) {
      return { valid: false, error: 'Discount code configuration is invalid' };
    }

    // Check usage limits
    if (code.used_count >= code.max_uses) {
      return { valid: false, error: 'Discount code usage limit reached' };
    }

    const userUsageCount = await this.usageRepository.count({
      where: { discount_code_id: code.id, user_id: userId },
    });

    if (userUsageCount >= code.max_uses_per_user) {
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
    if (code.discount_type === DiscountType.PERCENTAGE) {
      // Round to whole piastres in integer arithmetic: 12.5% of 99 EGP is 12.375, which the order flow
      // (toMinorUnits, two decimals max) would reject as an invalid amount and block checkout (F-12).
      const amountMinor = Math.round(dto.amount * 100);
      discountAmount = Math.round((amountMinor * discountValue) / 100) / 100;
      if (maxDiscount !== null && Number.isFinite(maxDiscount)) {
        discountAmount = Math.min(discountAmount, maxDiscount);
      }
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
      final_amount: Math.round((dto.amount - discountAmount) * 100) / 100,
    };
  }

  /**
   * Resolve one discount-code redemption for an entire cart.  The code is
   * redeemed once (not once per line); targeting is evaluated per product and
   * a fixed or capped discount is allocated deterministically to qualifying
   * lines.  The caller must use the returned allocation for the Orders it
   * creates and reserve the code with `applyDiscount` in the same transaction.
   */
  public async quoteCartDiscount(
    items: CartDiscountItem[],
    rawCode: string | undefined,
    userId: string,
    manager: EntityManager,
  ): Promise<CartDiscountQuote> {
    if (!rawCode?.trim()) {
      return {
        discount_code_id: null,
        discount_amount_minor: 0,
        applicable_subtotal_minor: 0,
        allocations_minor: Object.fromEntries(items.map((item) => [item.key, 0])),
        snapshot: null,
      };
    }
    if (
      items.length === 0 ||
      items.some((item) => !Number.isSafeInteger(item.amount_minor) || item.amount_minor <= 0)
    ) {
      throw new BadRequestException(
        biBody('Cart contains an invalid amount', 'تحتوي السلة على مبلغ غير صالح'),
      );
    }

    const code = await manager.findOne(DiscountCode, {
      where: { code: rawCode.trim().toUpperCase(), deleted_at: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (!code) {
      throw new BadRequestException(biBody('Discount code is invalid', 'رمز الخصم غير صالح'));
    }
    this.assertRedeemable(code);
    this.assertDiscountRules(
      code.discount_type,
      Number(code.discount_value),
      code.max_discount_amount === null ? null : Number(code.max_discount_amount),
    );
    if (code.used_count >= code.max_uses) {
      throw new BadRequestException(
        biBody('Discount code usage limit reached', 'تم الوصول إلى الحد الأقصى لاستخدام كود الخصم'),
      );
    }
    const usageCount = await manager.count(DiscountCodeUsage, {
      where: { discount_code_id: code.id, user_id: userId },
    });
    if (usageCount >= code.max_uses_per_user) {
      throw new BadRequestException(
        biBody('You have already used this discount code', 'لقد استخدمت كود الخصم بالفعل'),
      );
    }

    const qualifying = items.filter(
      (item) =>
        code.applicable_to.includes(item.item_type) &&
        (code.item_ids === null ||
          code.item_ids.length === 0 ||
          code.item_ids.includes(item.item_id)),
    );
    if (qualifying.length === 0) {
      throw new BadRequestException(
        biBody(
          'Discount code does not apply to items in this cart',
          'كود الخصم لا ينطبق على عناصر السلة',
        ),
      );
    }
    const applicableSubtotal = qualifying.reduce((sum, item) => sum + item.amount_minor, 0);
    const minimum = toMinorUnits(code.min_purchase_amount);
    if (applicableSubtotal < minimum) {
      throw new BadRequestException(
        biBody(
          `Minimum purchase amount is ${String(code.min_purchase_amount)} EGP`,
          `الحد الأدنى للشراء هو ${String(code.min_purchase_amount)} جنيه`,
        ),
      );
    }

    let totalDiscount =
      code.discount_type === DiscountType.PERCENTAGE
        ? Math.round((applicableSubtotal * toMinorUnits(code.discount_value)) / 10_000)
        : toMinorUnits(code.discount_value);
    if (code.discount_type === DiscountType.PERCENTAGE && code.max_discount_amount !== null) {
      totalDiscount = Math.min(totalDiscount, toMinorUnits(code.max_discount_amount));
    }
    totalDiscount = Math.min(totalDiscount, applicableSubtotal);
    if (totalDiscount <= 0) {
      throw new BadRequestException(
        biBody(
          'Discount code does not reduce this cart total',
          'كود الخصم لا يخفض إجمالي هذه السلة',
        ),
      );
    }
    const allocations = this.allocateCartDiscount(qualifying, applicableSubtotal, totalDiscount);
    const allocations_minor = Object.fromEntries(
      items.map((item) => [item.key, allocations[item.key] ?? 0]),
    );

    return {
      discount_code_id: code.id,
      discount_amount_minor: totalDiscount,
      applicable_subtotal_minor: applicableSubtotal,
      allocations_minor,
      snapshot: {
        code: code.code,
        discount_code_id: code.id,
        discount_type: code.discount_type,
        discount_value: Number(code.discount_value),
        applicable_subtotal_minor: applicableSubtotal,
        discount_amount_minor: totalDiscount,
        eligible_cart_item_ids: qualifying.map((item) => item.key),
        allocation_minor: allocations_minor,
      },
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
    orderAmount: number,
  ): Promise<void> {
    // Lock the discount code row for update
    const code = await manager.findOne(DiscountCode, {
      where: { id: discountCodeId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!code) {
      throw new NotFoundException(biBody('Discount code not found', 'كود الخصم غير موجود'));
    }

    this.assertRedeemable(code);

    if (
      !Number.isFinite(orderAmount) ||
      orderAmount <= 0 ||
      !Number.isFinite(discountAmount) ||
      discountAmount <= 0 ||
      discountAmount > orderAmount
    ) {
      throw new BadRequestException(
        biBody('Discount amount is invalid for this order', 'قيمة الخصم غير صالحة لهذا الطلب'),
      );
    }

    // Double-check global and per-user usage limits with the code lock held.
    if (code.used_count >= code.max_uses) {
      throw new BadRequestException(
        biBody('Discount code usage limit reached', 'تم الوصول إلى الحد الأقصى لاستخدام كود الخصم'),
      );
    }

    const userUsageCount = await manager.count(DiscountCodeUsage, {
      where: { discount_code_id: discountCodeId, user_id: userId },
    });
    if (userUsageCount >= code.max_uses_per_user) {
      throw new BadRequestException(
        biBody(
          "You have already reached this code's usage limit",
          'لقد تجاوزت حد استخدام هذا الكود',
        ),
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
      order: { used_at: 'DESC', id: 'DESC' },
      take: 100,
    });

    const aggregate = await this.usageRepository
      .createQueryBuilder('usage')
      .select('COALESCE(SUM(usage.discount_amount), 0)', 'total')
      .where('usage.discount_code_id = :id', { id })
      .getRawOne<{ total: string }>();
    const totalDiscountGiven = Number.parseFloat(aggregate?.total ?? '0');

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

  private assertDateRange(validFrom: Date, validUntil: Date | null): void {
    if (
      !Number.isFinite(validFrom.getTime()) ||
      (validUntil !== null && !Number.isFinite(validUntil.getTime()))
    ) {
      throw new BadRequestException(biBody('Invalid discount schedule', 'جدول الخصم غير صالح'));
    }
    if (validUntil !== null && validUntil <= validFrom) {
      throw new BadRequestException(
        biBody(
          'valid_until must be after valid_from',
          'يجب أن يكون تاريخ الانتهاء بعد تاريخ البدء',
        ),
      );
    }
  }

  /** Largest-remainder allocation keeps the exact integer total deterministic. */
  private allocateCartDiscount(
    items: CartDiscountItem[],
    subtotalMinor: number,
    discountMinor: number,
  ): Record<string, number> {
    if (discountMinor === 0) return Object.fromEntries(items.map((item) => [item.key, 0]));
    const provisional = items.map((item) => {
      const numerator = discountMinor * item.amount_minor;
      const amount = Math.floor(numerator / subtotalMinor);
      return { item, amount, remainder: numerator % subtotalMinor };
    });
    let remaining = discountMinor - provisional.reduce((sum, line) => sum + line.amount, 0);
    provisional.sort(
      (left, right) =>
        right.remainder - left.remainder || left.item.key.localeCompare(right.item.key),
    );
    for (const line of provisional) {
      if (remaining <= 0) break;
      if (line.amount < line.item.amount_minor) {
        line.amount += 1;
        remaining -= 1;
      }
    }
    return Object.fromEntries(provisional.map((line) => [line.item.key, line.amount]));
  }

  private assertDiscountRules(
    type: DiscountType,
    value: number,
    maxDiscountAmount: number | null | undefined,
  ): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(
        biBody('Discount value must be greater than zero', 'قيمة الخصم يجب أن تكون أكبر من صفر'),
      );
    }
    if (type === DiscountType.PERCENTAGE && (value < 1 || value > 100)) {
      throw new BadRequestException(
        biBody(
          'Percentage discount must be between 1% and 100%',
          'يجب أن تكون نسبة الخصم بين 1% و100%',
        ),
      );
    }
    if (
      type !== DiscountType.PERCENTAGE &&
      maxDiscountAmount !== null &&
      maxDiscountAmount !== undefined
    ) {
      throw new BadRequestException(
        biBody(
          'Maximum discount amount is only valid for percentage codes',
          'الحد الأقصى للخصم متاح للنسب المئوية فقط',
        ),
      );
    }
    if (
      maxDiscountAmount !== null &&
      maxDiscountAmount !== undefined &&
      (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount <= 0)
    ) {
      throw new BadRequestException(
        biBody(
          'Maximum discount amount must be greater than zero',
          'الحد الأقصى للخصم يجب أن يكون أكبر من صفر',
        ),
      );
    }
  }

  private assertUsageLimits(maxUses: number, maxUsesPerUser: number): void {
    if (
      !Number.isSafeInteger(maxUses) ||
      !Number.isSafeInteger(maxUsesPerUser) ||
      maxUses < 1 ||
      maxUsesPerUser < 1 ||
      maxUsesPerUser > maxUses
    ) {
      throw new BadRequestException(
        biBody(
          'Per-user uses must be a positive whole number no greater than total uses',
          'يجب أن يكون حد الاستخدام لكل مستخدم رقمًا صحيحًا موجبًا لا يتجاوز إجمالي الاستخدامات',
        ),
      );
    }
  }

  private assertRedeemable(code: DiscountCode): void {
    const now = new Date();
    if (!code.is_active || code.deleted_at !== null) {
      throw new BadRequestException(biBody('Discount code is inactive', 'كود الخصم غير نشط'));
    }
    if (now < code.valid_from || (code.valid_until !== null && now > code.valid_until)) {
      throw new BadRequestException(
        biBody('Discount code is outside its valid period', 'كود الخصم خارج فترة الصلاحية'),
      );
    }
  }
}
