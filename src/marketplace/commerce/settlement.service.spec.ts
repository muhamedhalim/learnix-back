import { EventEmitter2 } from '@nestjs/event-emitter';

import { MarketplaceOrderStatus } from '../common/enums';
import { MarketplaceSettlementService } from './settlement.service';

function buildEarnings() {
  return { moveToRefundClearance: jest.fn().mockResolvedValue(undefined) };
}

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    learner_id: 'learner-1',
    course_id: 'course-1',
    course_version_id: 'v1',
    instructor_id: 'instructor-1',
    status: MarketplaceOrderStatus.AWAITING_PAYMENT,
    net_amount_minor: 5000,
    currency: 'EGP',
    commission_bps: 3000,
    commission_amount_minor: 1500,
    instructor_earning_minor: 3500,
    refund_window_days: 14,
    is_zero_value: false,
    paid_at: null,
    ...overrides,
  };
}

function buildPayment(overrides: Record<string, unknown> = {}) {
  return { id: 'payment-1', item_id: 'order-1', ...overrides };
}

function buildManager(opts: {
  order?: Record<string, unknown> | null;
  failOn?: 'order' | 'enrollment' | 'earning' | 'ledger';
}) {
  const order = 'order' in opts ? opts.order : buildOrder();
  const saved: Record<string, unknown[]> = { order: [], enrollment: [], payment: [], auditLog: [] };

  const repos = {
    order: {
      findOne: jest.fn().mockResolvedValue(order),
      save: jest.fn(async (data: Record<string, unknown>) => {
        if (opts.failOn === 'order') throw new Error('forced order save failure');
        saved.order.push(data);
        return data;
      }),
    },
    enrollment: {
      create: jest.fn((data: Record<string, unknown>) => data),
      save: jest.fn(async (data: Record<string, unknown>) => {
        if (opts.failOn === 'enrollment') throw new Error('forced enrollment save failure');
        saved.enrollment.push(data);
        return { id: 'enrollment-1', ...data };
      }),
    },
    payment: {
      findOne: jest.fn().mockResolvedValue(buildPayment()),
      save: jest.fn(async (data: Record<string, unknown>) => data),
    },
    auditLog: { insert: jest.fn().mockResolvedValue(undefined) },
  };

  const manager = {
    getRepository: jest.fn((entity: { name?: string }) => {
      const name = typeof entity === 'function' ? entity.name : String(entity);
      if (name === 'MarketplaceOrder') return repos.order;
      if (name === 'MarketplaceEnrollment') return repos.enrollment;
      if (name === 'Payment') return repos.payment;
      if (name === 'PaymentAuditLog') return repos.auditLog;
      throw new Error(`unexpected repository requested: ${name}`);
    }),
  };
  return { manager, repos, saved };
}

function buildLedger(failOn?: 'earning' | 'ledger') {
  const calls: unknown[] = [];
  return {
    createEarning: jest.fn(async (input: unknown) => {
      if (failOn === 'earning') throw new Error('forced earning save failure');
      return { id: 'earning-1', ...(input as object) };
    }),
    post: jest.fn(async (input: unknown) => {
      if (failOn === 'ledger') throw new Error('forced ledger post failure');
      calls.push(input);
      return { id: `ledger-${calls.length}`, ...(input as object) };
    }),
    buildReference: jest.fn((type: string, orderId: string, seq: number) => `${type}:${orderId}:${seq}`),
    calls,
  };
}

describe('MarketplaceSettlementService (T098, T100)', () => {
  it('writes the order status, enrollment, earning and both ledger entries together (FR-099, FR-102)', async () => {
    const { manager } = buildManager({});
    const ledger = buildLedger();
    const eventEmitter = new EventEmitter2();
    const earnings = buildEarnings();
    const service = new MarketplaceSettlementService(ledger as never, earnings as never, eventEmitter);

    const outcome = await service.settle('payment-1', 5000, 'EGP', manager as never);

    expect(outcome).toBe('settled');
    expect(ledger.post).toHaveBeenCalledTimes(2);
    expect(ledger.calls).toEqual([
      expect.objectContaining({ entryType: 'course_sale', amountMinor: 3500, direction: 'credit' }),
      expect.objectContaining({ entryType: 'platform_commission', amountMinor: 1500, direction: 'debit' }),
    ]);
    // T162: the earning moves straight to REFUND_CLEARANCE — "confirmed
    // settled by the provider" (FR-145) is this exact moment.
    expect(earnings.moveToRefundClearance).toHaveBeenCalledWith(manager, 'earning-1');
  });

  it('never transitions an earning for a zero-value order (none was created, FR-114)', async () => {
    const { manager } = buildManager({ order: buildOrder({ net_amount_minor: 0, commission_amount_minor: 0, instructor_earning_minor: 0, is_zero_value: true }) });
    const ledger = buildLedger();
    const earnings = buildEarnings();
    const service = new MarketplaceSettlementService(ledger as never, earnings as never, new EventEmitter2());

    await service.settle('payment-1', 0, 'EGP', manager as never);

    expect(earnings.moveToRefundClearance).not.toHaveBeenCalled();
  });

  it('is idempotent: settling an already-paid order is a no-op that creates nothing new', async () => {
    const { manager, repos } = buildManager({ order: buildOrder({ status: MarketplaceOrderStatus.PAID }) });
    const ledger = buildLedger();
    const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

    const outcome = await service.settle('payment-1', 5000, 'EGP', manager as never);

    expect(outcome).toBe('already_settled');
    expect(repos.enrollment.save).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('grants nothing and posts no ledger entry on an amount mismatch (FR-104)', async () => {
    const { manager, repos } = buildManager({});
    const ledger = buildLedger();
    const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

    const outcome = await service.settle('payment-1', 4999, 'EGP', manager as never);

    expect(outcome).toBe('discrepancy');
    expect(repos.enrollment.save).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
    expect(repos.payment.save).toHaveBeenCalledWith(expect.objectContaining({ reconciliation_status: 'reconciliation_required' }));
  });

  it('grants nothing and posts no ledger entry on a currency mismatch (FR-104)', async () => {
    const { manager, repos } = buildManager({});
    const ledger = buildLedger();
    const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

    const outcome = await service.settle('payment-1', 5000, 'USD', manager as never);

    expect(outcome).toBe('discrepancy');
    expect(repos.enrollment.save).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('creates no earning and posts no ledger entry for a zero-value (free) order (FR-114)', async () => {
    const { manager, repos } = buildManager({ order: buildOrder({ net_amount_minor: 0, commission_amount_minor: 0, instructor_earning_minor: 0, is_zero_value: true }) });
    const ledger = buildLedger();
    const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

    const outcome = await service.settle('payment-1', 0, 'EGP', manager as never);

    expect(outcome).toBe('settled');
    expect(repos.enrollment.save).toHaveBeenCalled();
    expect(ledger.createEarning).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
  });

  describe('a forced failure at each step propagates rather than being swallowed or compensated (FR-099 atomicity)', () => {
    it.each(['order', 'enrollment'] as const)('fails cleanly when the %s write fails', async (step) => {
      const { manager } = buildManager({ failOn: step });
      const ledger = buildLedger();
      const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

      await expect(service.settle('payment-1', 5000, 'EGP', manager as never)).rejects.toThrow(`forced ${step} save failure`);
    });

    it('fails cleanly when the earning write fails', async () => {
      const { manager } = buildManager({});
      const ledger = buildLedger('earning');
      const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

      await expect(service.settle('payment-1', 5000, 'EGP', manager as never)).rejects.toThrow('forced earning save failure');
    });

    it('fails cleanly when the ledger post fails', async () => {
      const { manager } = buildManager({});
      const ledger = buildLedger('ledger');
      const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

      await expect(service.settle('payment-1', 5000, 'EGP', manager as never)).rejects.toThrow('forced ledger post failure');
    });
  });

  it('never re-checks the course’s live status at settlement — an order settles even if the course was unpublished after purchase (FR-103, T100)', async () => {
    // settle() only ever reads MarketplaceOrder (the purchase snapshot) — it has no
    // dependency on MarketplaceCourse at all, so there is nothing here that could
    // refuse settlement based on the course's current state.
    const { manager } = buildManager({});
    const ledger = buildLedger();
    const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());
    const outcome = await service.settle('payment-1', 5000, 'EGP', manager as never);
    expect(outcome).toBe('settled');
  });

  describe('settleFree (T111)', () => {
    it('grants enrollment for a zero-value order with no earning and no ledger entry, and no gateway/Payment lookup at all', async () => {
      const { manager, repos } = buildManager({
        order: buildOrder({ status: MarketplaceOrderStatus.AWAITING_PAYMENT, net_amount_minor: 0, commission_amount_minor: 0, instructor_earning_minor: 0, is_zero_value: true }),
      });
      const ledger = buildLedger();
      const service = new MarketplaceSettlementService(ledger as never, buildEarnings() as never, new EventEmitter2());

      const outcome = await service.settleFree('order-1', manager as never);

      expect(outcome).toBe('settled');
      expect(repos.enrollment.save).toHaveBeenCalled();
      expect(ledger.createEarning).not.toHaveBeenCalled();
      expect(ledger.post).not.toHaveBeenCalled();
      expect(manager.getRepository).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Payment' }));
    });

    it('is idempotent: settling an already-paid free order is a no-op', async () => {
      const { manager, repos } = buildManager({
        order: buildOrder({ status: MarketplaceOrderStatus.PAID, is_zero_value: true, net_amount_minor: 0, commission_amount_minor: 0, instructor_earning_minor: 0 }),
      });
      const service = new MarketplaceSettlementService(buildLedger() as never, buildEarnings() as never, new EventEmitter2());

      const outcome = await service.settleFree('order-1', manager as never);

      expect(outcome).toBe('already_settled');
      expect(repos.enrollment.save).not.toHaveBeenCalled();
    });

    it('refuses to grant a real paid order for free — defense in depth against a caller mistake', async () => {
      const { manager } = buildManager({
        order: buildOrder({ is_zero_value: false, net_amount_minor: 5000 }),
      });
      const service = new MarketplaceSettlementService(buildLedger() as never, buildEarnings() as never, new EventEmitter2());

      await expect(service.settleFree('order-1', manager as never)).rejects.toThrow();
    });

    it('404s for a nonexistent order', async () => {
      const { manager } = buildManager({ order: null });
      const service = new MarketplaceSettlementService(buildLedger() as never, buildEarnings() as never, new EventEmitter2());

      await expect(service.settleFree('missing-order', manager as never)).rejects.toThrow();
    });
  });

  describe('markFailed (T105)', () => {
    it('transitions an awaiting-payment order to failed and emits the domain event', async () => {
      const { manager, repos } = buildManager({});
      const eventEmitter = new EventEmitter2();
      const emitSpy = jest.spyOn(eventEmitter, 'emit');
      const service = new MarketplaceSettlementService(buildLedger() as never, buildEarnings() as never, eventEmitter);

      const outcome = await service.markFailed('payment-1', manager as never);

      expect(outcome).toBe('failed');
      expect(repos.order.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
      expect(emitSpy).toHaveBeenCalledWith('marketplace.order.failed', expect.objectContaining({ orderId: 'order-1' }));
    });

    it('is a no-op (ignored) for an order that is not awaiting payment — a late "failed" webhook can never undo an already-settled order (out-of-order redelivery)', async () => {
      const { manager, repos } = buildManager({ order: buildOrder({ status: MarketplaceOrderStatus.PAID }) });
      const service = new MarketplaceSettlementService(buildLedger() as never, buildEarnings() as never, new EventEmitter2());

      const outcome = await service.markFailed('payment-1', manager as never);

      expect(outcome).toBe('ignored');
      expect(repos.order.save).not.toHaveBeenCalled();
    });
  });
});
