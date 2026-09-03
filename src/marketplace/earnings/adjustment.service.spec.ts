import { BadRequestException } from '@nestjs/common';

import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType } from '../common/enums';
import { AdjustmentService } from './adjustment.service';

describe('AdjustmentService (T171)', () => {
  let ledger: { post: jest.Mock };
  let balance: { getBalance: jest.Mock };
  let earningsRepo: { exist: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let activityLogs: { recordAuditEvent: jest.Mock };
  let service: AdjustmentService;

  const input = {
    instructorId: 'instructor-1',
    currency: 'EGP',
    amountMinor: 1000,
    direction: MarketplaceLedgerDirection.CREDIT,
    reason: 'Goodwill credit',
    adminId: 'admin-1',
    idempotencyKey: 'idem-1',
  };

  beforeEach(() => {
    ledger = { post: jest.fn().mockResolvedValue({ id: 'ledger-1' }) };
    balance = { getBalance: jest.fn() };
    earningsRepo = { exist: jest.fn().mockResolvedValue(true) };
    dataSource = { transaction: jest.fn((fn: (m: unknown) => unknown) => fn({})) };
    activityLogs = { recordAuditEvent: jest.fn() };
    service = new AdjustmentService(ledger as never, balance as never, earningsRepo as never, dataSource as never, activityLogs as never);
  });

  it('requires a non-empty reason', async () => {
    await expect(service.createAdjustment({ ...input, reason: '  ' })).rejects.toThrow(BadRequestException);
  });

  it('refuses a currency the instructor holds no earnings in at all (FR-173)', async () => {
    earningsRepo.exist.mockResolvedValue(false);
    await expect(service.createAdjustment(input)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADJUSTMENT_CURRENCY_NOT_HELD' }),
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('refuses a debit that would drive the available balance negative (FR-173)', async () => {
    balance.getBalance.mockResolvedValue({ availableMinor: 500 });
    await expect(
      service.createAdjustment({ ...input, direction: MarketplaceLedgerDirection.DEBIT, amountMinor: 1000 }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ADJUSTMENT_WOULD_GO_NEGATIVE' }) });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('allows a debit that leaves the balance at exactly zero', async () => {
    balance.getBalance.mockResolvedValue({ availableMinor: 1000 });
    await service.createAdjustment({ ...input, direction: MarketplaceLedgerDirection.DEBIT, amountMinor: 1000 });
    expect(ledger.post).toHaveBeenCalled();
  });

  it('never checks the balance for a credit adjustment (no negative-balance risk)', async () => {
    await service.createAdjustment(input);
    expect(balance.getBalance).not.toHaveBeenCalled();
  });

  it('posts a MANUAL_ADJUSTMENT entry carrying the actor and reason, with a deterministic reference', async () => {
    await service.createAdjustment(input);

    expect(ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({
        instructorId: 'instructor-1',
        orderId: null,
        entryType: MarketplaceLedgerEntryType.MANUAL_ADJUSTMENT,
        amountMinor: 1000,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.CREDIT,
        reference: 'manual_adjustment:instructor-1:EGP:idem-1',
        createdBy: 'admin-1',
        metadata: { reason: 'Goodwill credit' },
      }),
      {},
    );
    expect(activityLogs.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'marketplace_ledger_adjustment',
        adminId: 'admin-1',
        details: expect.objectContaining({ instructorId: 'instructor-1', amountMinor: 1000, currency: 'EGP', reason: 'Goodwill credit' }),
      }),
    );
  });
});
