import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MarketplaceEnrollment, MarketplaceOrder } from '../commerce/entities';
import { MarketplaceOrderStatus } from '../common/enums';
import { MARKETPLACE_ERROR_CODES } from '../common/errors';
import { RefundEligibilityService } from './eligibility.service';

function order(overrides: Partial<MarketplaceOrder> = {}): MarketplaceOrder {
  return {
    id: 'order-1',
    is_zero_value: false,
    paid_at: new Date('2026-01-01T00:00:00.000Z'),
    refund_window_days: 14,
    consumption_cap_bps: 3000,
    status: MarketplaceOrderStatus.PAID,
    ...overrides,
  } as MarketplaceOrder;
}

describe('RefundEligibilityService (T134)', () => {
  let service: RefundEligibilityService;
  let ordersRepo: { findOne: jest.Mock };
  let enrollmentsRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    ordersRepo = { findOne: jest.fn() };
    enrollmentsRepo = { findOne: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        RefundEligibilityService,
        { provide: getRepositoryToken(MarketplaceOrder), useValue: ordersRepo },
        { provide: getRepositoryToken(MarketplaceEnrollment), useValue: enrollmentsRepo },
      ],
    }).compile();
    service = module.get(RefundEligibilityService);
  });

  describe('window boundary (FR-179 — inclusive of the final instant)', () => {
    it('accepts a request made exactly at day 14', () => {
      const now = new Date('2026-01-15T00:00:00.000Z');
      const verdict = service.evaluate(order(), 0, now);
      expect(verdict.eligible).toBe(true);
      expect(verdict.failedCondition).toBeNull();
    });

    it('refuses a request made one millisecond after day 14', () => {
      const now = new Date('2026-01-15T00:00:00.001Z');
      const verdict = service.evaluate(order(), 0, now);
      expect(verdict.eligible).toBe(false);
      expect(verdict.failedCondition).toBe(MARKETPLACE_ERROR_CODES.REFUND_WINDOW_EXPIRED);
      expect(verdict.daysRemaining).toBe(0);
    });
  });

  describe('consumption cap (FR-178 — exclusive)', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');

    it('accepts progress just under the cap', () => {
      const verdict = service.evaluate(order(), 2999, now);
      expect(verdict.eligible).toBe(true);
    });

    it('refuses progress exactly at the cap', () => {
      const verdict = service.evaluate(order(), 3000, now);
      expect(verdict.eligible).toBe(false);
      expect(verdict.failedCondition).toBe(MARKETPLACE_ERROR_CODES.REFUND_CONSUMPTION_EXCEEDED);
    });

    it('refuses progress above the cap', () => {
      const verdict = service.evaluate(order(), 5000, now);
      expect(verdict.eligible).toBe(false);
      expect(verdict.failedCondition).toBe(MARKETPLACE_ERROR_CODES.REFUND_CONSUMPTION_EXCEEDED);
    });
  });

  it('always refuses a zero-value order as nothing to refund (FR-119), ignoring window/cap', () => {
    const verdict = service.evaluate(
      order({ is_zero_value: true, paid_at: null }),
      0,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.failedCondition).toBe(MARKETPLACE_ERROR_CODES.NOTHING_TO_REFUND);
  });

  it('reads window/cap from the order snapshot, not any external config', () => {
    const verdict = service.evaluate(
      order({ refund_window_days: 30, consumption_cap_bps: 5000 }),
      4000,
      new Date('2026-01-20T00:00:00.000Z'),
    );
    expect(verdict.eligible).toBe(true);
    expect(verdict.windowDays).toBe(30);
    expect(verdict.capBps).toBe(5000);
  });

  describe('checkEligibility (learner-facing lookup)', () => {
    it('scopes the order lookup to the requesting learner (IDOR-safe 404)', async () => {
      ordersRepo.findOne.mockResolvedValue(null);
      await expect(service.checkEligibility('learner-1', 'order-1')).rejects.toThrow(
        'Order not found',
      );
      expect(ordersRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'order-1', learner_id: 'learner-1' },
      });
    });

    it('uses the enrollment progress_bps cache when an enrollment exists', async () => {
      ordersRepo.findOne.mockResolvedValue(order());
      enrollmentsRepo.findOne.mockResolvedValue({ progress_bps: 1500 } as MarketplaceEnrollment);
      const verdict = await service.checkEligibility('learner-1', 'order-1');
      expect(verdict.progressBps).toBe(1500);
    });

    it('treats a missing enrollment as zero progress rather than throwing', async () => {
      ordersRepo.findOne.mockResolvedValue(order());
      enrollmentsRepo.findOne.mockResolvedValue(null);
      const verdict = await service.checkEligibility('learner-1', 'order-1');
      expect(verdict.progressBps).toBe(0);
    });
  });

  describe('evaluateForOrder', () => {
    it('refuses an order that is not PAID as nothing to refund', () => {
      const verdict = service.evaluateForOrder(
        order({ status: MarketplaceOrderStatus.AWAITING_PAYMENT }),
        { progress_bps: 0 } as MarketplaceEnrollment,
      );
      expect(verdict.eligible).toBe(false);
      expect(verdict.failedCondition).toBe(MARKETPLACE_ERROR_CODES.NOTHING_TO_REFUND);
    });

    it('delegates to evaluate() for a paid order', () => {
      const verdict = service.evaluateForOrder(
        order(),
        { progress_bps: 100 } as MarketplaceEnrollment,
        new Date('2026-01-02T00:00:00.000Z'),
      );
      expect(verdict.eligible).toBe(true);
    });
  });
});
