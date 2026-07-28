import { BadRequestException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DiscountCodesService } from './discount-codes.service';
import { DiscountCode, DiscountCodeUsage, DiscountType } from './entities';
import { ApplicableItem } from './entities/applicable-item.enum';

describe('DiscountCodesService', () => {
  let service: DiscountCodesService;
  let codesRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let usageRepo: { count: jest.Mock };

  const buildCode = (over: Partial<DiscountCode> = {}): DiscountCode =>
    ({
      id: 'dc-1',
      code: 'SAVE20',
      is_active: true,
      valid_from: new Date(Date.now() - 86_400_000),
      valid_until: new Date(Date.now() + 86_400_000),
      used_count: 0,
      max_uses: 100,
      max_uses_per_user: 1,
      max_discount_amount: null,
      deleted_at: null,
      applicable_to: [ApplicableItem.LESSON],
      item_ids: null,
      min_purchase_amount: 0,
      discount_type: DiscountType.PERCENTAGE,
      discount_value: 20,
      ...over,
    }) as unknown as DiscountCode;

  const dto = {
    code: 'SAVE20',
    item_type: ApplicableItem.LESSON,
    item_id: 'lesson-1',
    amount: 100,
  };

  beforeEach(async () => {
    codesRepo = {
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    usageRepo = { count: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscountCodesService,
        { provide: getRepositoryToken(DiscountCode), useValue: codesRepo },
        { provide: getRepositoryToken(DiscountCodeUsage), useValue: usageRepo },
      ],
    }).compile();

    service = module.get(DiscountCodesService);
  });

  describe('verifyCode — the full validity matrix', () => {
    it('accepts a valid percentage code and computes the discount', async () => {
      codesRepo.findOne.mockResolvedValue(buildCode());

      const result = await service.verifyCode(dto, 'user-1');

      expect(result.valid).toBe(true);
      expect(result.discount_amount).toBe(20);
      expect(result.final_amount).toBe(80);
    });

    it('rejects an inactive/unknown code (repo filters is_active)', async () => {
      codesRepo.findOne.mockResolvedValue(null);
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
    });

    it('rejects an expired code', async () => {
      codesRepo.findOne.mockResolvedValue(buildCode({ valid_until: new Date(Date.now() - 1000) }));
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/expired/i);
    });

    it('rejects a not-yet-valid code', async () => {
      codesRepo.findOne.mockResolvedValue(
        buildCode({ valid_from: new Date(Date.now() + 86_400_000) }),
      );
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
    });

    it('rejects when the global usage limit is reached', async () => {
      codesRepo.findOne.mockResolvedValue(buildCode({ used_count: 100, max_uses: 100 }));
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/limit/i);
    });

    it('rejects a second use by the same user (per-user limit = 1)', async () => {
      codesRepo.findOne.mockResolvedValue(buildCode());
      usageRepo.count.mockResolvedValue(1);
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/already used/i);
    });

    it('rejects a code scoped to a different item type', async () => {
      codesRepo.findOne.mockResolvedValue(
        buildCode({ applicable_to: [ApplicableItem.BOOK] as never }),
      );
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
    });

    it('rejects a code pinned to specific other items', async () => {
      codesRepo.findOne.mockResolvedValue(buildCode({ item_ids: ['other-lesson'] as never }));
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
    });

    it('rejects below the minimum purchase amount', async () => {
      codesRepo.findOne.mockResolvedValue(buildCode({ min_purchase_amount: 500 as never }));
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(false);
    });

    it('caps a fixed discount at the item price (never negative totals)', async () => {
      codesRepo.findOne.mockResolvedValue(
        buildCode({ discount_type: DiscountType.FIXED, discount_value: 250 as never }),
      );
      const result = await service.verifyCode(dto, 'user-1');
      expect(result.valid).toBe(true);
      expect(result.discount_amount).toBe(100);
      expect(result.final_amount).toBe(0);
    });

    it('supports an open-ended code and caps percentage discounts when configured', async () => {
      codesRepo.findOne.mockResolvedValue(
        buildCode({ valid_until: null, discount_value: 50, max_discount_amount: 30 }),
      );

      const result = await service.verifyCode(dto, 'user-1');

      expect(result.valid).toBe(true);
      expect(result.discount_amount).toBe(30);
      expect(result.final_amount).toBe(70);
    });

    it('fails safely if a legacy percentage configuration exceeds 100%', async () => {
      codesRepo.findOne.mockResolvedValue(buildCode({ discount_value: 120 }));

      const result = await service.verifyCode(dto, 'user-1');

      expect(result).toEqual({ valid: false, error: 'Discount code configuration is invalid' });
    });
  });

  describe('create — contract validation', () => {
    const createDto = {
      code: 'fixed-150',
      discount_type: DiscountType.FIXED,
      discount_value: 150,
      applicable_to: [ApplicableItem.LESSON],
      max_uses: 5,
      max_uses_per_user: 2,
      valid_until: null,
    };

    it('accepts a fixed amount above 100 and stores the clear fixed type', async () => {
      codesRepo.findOne.mockResolvedValue(null);

      const created = await service.create(createDto);

      expect(codesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'FIXED-150',
          discount_type: DiscountType.FIXED,
          discount_value: 150,
          valid_until: null,
          max_uses_per_user: 2,
        }),
      );
      expect(created.discount_type).toBe(DiscountType.FIXED);
    });

    it('rejects zero values, percentages above 100, and invalid usage limits', async () => {
      codesRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create({ ...createDto, discount_value: 0 } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({
          ...createDto,
          discount_type: DiscountType.PERCENTAGE,
          discount_value: 0.5,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({
          ...createDto,
          discount_type: DiscountType.PERCENTAGE,
          discount_value: 101,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({ ...createDto, max_uses_per_user: 6 } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an end date before the start date', async () => {
      codesRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create({
          ...createDto,
          valid_from: '2026-01-02T00:00:00.000Z',
          valid_until: '2026-01-01T00:00:00.000Z',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('applyDiscount — transaction enforcement', () => {
    it('locks the code and rejects an exhausted per-user limit before recording usage', async () => {
      const manager = {
        findOne: jest.fn().mockResolvedValue(buildCode({ max_uses_per_user: 2 })),
        count: jest.fn().mockResolvedValue(2),
        create: jest.fn(),
        save: jest.fn(),
      };

      await expect(
        service.applyDiscount('dc-1', 'user-1', 'payment-1', 20, manager as never, 100),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('never records a discount larger than the order', async () => {
      const manager = {
        findOne: jest.fn().mockResolvedValue(buildCode()),
        count: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
      };

      await expect(
        service.applyDiscount('dc-1', 'user-1', 'payment-1', 101, manager as never, 100),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.count).not.toHaveBeenCalled();
    });
  });

  describe('releaseUsageForPayment — failed/expired checkout hands the code back', () => {
    it('deletes the usage row and decrements the counter under lock', async () => {
      const manager = {
        find: jest
          .fn()
          .mockResolvedValue([{ id: 'usage-1', discount_code_id: 'dc-1', payment_id: 'pay-1' }]),
        findOne: jest.fn().mockResolvedValue(buildCode({ used_count: 5 })),
        delete: jest.fn().mockResolvedValue(undefined),
        save: jest.fn().mockResolvedValue(undefined),
      };

      await service.releaseUsageForPayment('pay-1', manager as never);

      expect(manager.delete).toHaveBeenCalledWith(DiscountCodeUsage, { id: 'usage-1' });
      const saved = manager.save.mock.calls[0]?.[1] as DiscountCode;
      expect(saved.used_count).toBe(4);
    });

    it('is a no-op when the payment used no discount', async () => {
      const manager = {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn(),
        delete: jest.fn(),
        save: jest.fn(),
      };

      await service.releaseUsageForPayment('pay-1', manager as never);

      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('never drives the counter below zero', async () => {
      const manager = {
        find: jest
          .fn()
          .mockResolvedValue([{ id: 'usage-1', discount_code_id: 'dc-1', payment_id: 'pay-1' }]),
        findOne: jest.fn().mockResolvedValue(buildCode({ used_count: 0 })),
        delete: jest.fn().mockResolvedValue(undefined),
        save: jest.fn().mockResolvedValue(undefined),
      };

      await service.releaseUsageForPayment('pay-1', manager as never);

      expect(manager.delete).toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });
});
