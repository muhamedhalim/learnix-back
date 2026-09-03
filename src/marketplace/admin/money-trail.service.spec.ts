import { NotFoundException } from '@nestjs/common';

import { MarketplaceCommissionScope, InstructorEarningStatus, MarketplaceLedgerDirection, MarketplaceLedgerEntryType, PayoutRequestStatus, RefundRequestStatus } from '../common/enums';
import { MoneyTrailService } from './money-trail.service';

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    order_number: 'MP-1',
    currency: 'EGP',
    gross_amount_minor: 10000,
    discount_amount_minor: 0,
    net_amount_minor: 10000,
    commission_bps: 3000,
    commission_scope: MarketplaceCommissionScope.PLATFORM,
    commission_amount_minor: 3000,
    instructor_earning_minor: 7000,
    ...overrides,
  };
}

describe('MoneyTrailService (T187, FR-287)', () => {
  let orders: { findOne: jest.Mock };
  let earnings: { findOne: jest.Mock };
  let refunds: { find: jest.Mock };
  let ledgerEntries: { find: jest.Mock };
  let payoutRequests: { findOne: jest.Mock };
  let service: MoneyTrailService;

  beforeEach(() => {
    orders = { findOne: jest.fn() };
    earnings = { findOne: jest.fn().mockResolvedValue(null) };
    refunds = { find: jest.fn().mockResolvedValue([]) };
    ledgerEntries = { find: jest.fn().mockResolvedValue([]) };
    payoutRequests = { findOne: jest.fn() };
    service = new MoneyTrailService(orders as never, earnings as never, refunds as never, ledgerEntries as never, payoutRequests as never);
  });

  it('404s an order that does not exist', async () => {
    orders.findOne.mockResolvedValue(null);
    await expect(service.getMoneyTrail('missing')).rejects.toThrow(NotFoundException);
  });

  it('reads every figure straight off the order snapshot, no recomputation', async () => {
    orders.findOne.mockResolvedValue(buildOrder());

    const trail = await service.getMoneyTrail('order-1');

    expect(trail.gross_amount_minor).toBe(10000);
    expect(trail.commission_amount_minor).toBe(3000);
    expect(trail.instructor_earning_minor).toBe(7000);
    expect(trail.earning).toBeNull();
    expect(trail.payout).toBeNull();
  });

  it('includes the earning, every refund, every ledger entry, and the containing payout when present', async () => {
    orders.findOne.mockResolvedValue(buildOrder());
    earnings.findOne.mockResolvedValue({
      id: 'earning-1',
      status: InstructorEarningStatus.PAID_OUT,
      available_at: new Date('2026-01-15T00:00:00.000Z'),
      reversed_at: null,
      payout_request_id: 'payout-1',
    });
    refunds.find.mockResolvedValue([
      { id: 'refund-1', status: RefundRequestStatus.COMPLETED, created_at: new Date('2026-01-10T00:00:00.000Z'), decided_at: new Date('2026-01-10T00:05:00.000Z'), refund_reference: 'REF-1' },
    ]);
    ledgerEntries.find.mockResolvedValue([
      { id: 'ledger-1', entry_type: MarketplaceLedgerEntryType.COURSE_SALE, direction: MarketplaceLedgerDirection.CREDIT, amount_minor: '7000', created_at: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    payoutRequests.findOne.mockResolvedValue({ id: 'payout-1', request_number: 'PR-1', status: PayoutRequestStatus.PAID, payout_reference: 'TXN-1' });

    const trail = await service.getMoneyTrail('order-1');

    expect(trail.earning?.status).toBe(InstructorEarningStatus.PAID_OUT);
    expect(trail.refunds).toHaveLength(1);
    expect(trail.refunds[0]!.refund_reference).toBe('REF-1');
    expect(trail.ledger_entries).toHaveLength(1);
    expect(trail.ledger_entries[0]!.amount_minor).toBe(7000); // normalized from the raw bigint-as-string
    expect(trail.payout).toEqual({ id: 'payout-1', request_number: 'PR-1', status: PayoutRequestStatus.PAID, payout_reference: 'TXN-1' });
    expect(payoutRequests.findOne).toHaveBeenCalledWith({ where: { id: 'payout-1' } });
  });

  it('never looks up a payout when the earning was never locked to one', async () => {
    orders.findOne.mockResolvedValue(buildOrder());
    earnings.findOne.mockResolvedValue({
      id: 'earning-1',
      status: InstructorEarningStatus.AVAILABLE_BALANCE,
      available_at: new Date('2026-01-15T00:00:00.000Z'),
      reversed_at: null,
      payout_request_id: null,
    });

    const trail = await service.getMoneyTrail('order-1');

    expect(trail.payout).toBeNull();
    expect(payoutRequests.findOne).not.toHaveBeenCalled();
  });
});
