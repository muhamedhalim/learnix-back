import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DiscountCodesService } from './discount-codes.service';
import { DiscountCode, DiscountCodeUsage, DiscountType } from './entities';
import { ApplicableItem } from './entities/applicable-item.enum';

describe('DiscountCodesService', () => {
  let service: DiscountCodesService;
  let codesRepo: { findOne: jest.Mock };
  let usageRepo: { findOne: jest.Mock };

  const buildCode = (over: Partial<DiscountCode> = {}): DiscountCode =>
    ({
      id: 'dc-1',
      code: 'SAVE20',
      is_active: true,
      valid_from: new Date(Date.now() - 86_400_000),
      valid_until: new Date(Date.now() + 86_400_000),
      used_count: 0,
      max_uses: 100,
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
    codesRepo = { findOne: jest.fn() };
    usageRepo = { findOne: jest.fn().mockResolvedValue(null) };

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
      codesRepo.findOne.mockResolvedValue(
        buildCode({ valid_until: new Date(Date.now() - 1000) }),
      );
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
      usageRepo.findOne.mockResolvedValue({ id: 'usage-1' });
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
