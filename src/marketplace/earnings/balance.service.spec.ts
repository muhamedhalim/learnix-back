import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType } from '../common/enums';
import { BalanceService } from './balance.service';
import { InstructorEarning } from './entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from './entities/marketplace-ledger-entry.entity';
import { LedgerService } from './ledger.service';

describe('BalanceService (T139)', () => {
  let service: BalanceService;
  let ledger: { deriveBalance: jest.Mock; post: jest.Mock };
  let qb: { where: jest.Mock; andWhere: jest.Mock; select: jest.Mock; getRawOne: jest.Mock };
  let ledgerEntries: { createQueryBuilder: jest.Mock };
  let earningsRepo: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    ledger = { deriveBalance: jest.fn(), post: jest.fn() };
    qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
    } as never;
    ledgerEntries = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    earningsRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: LedgerService, useValue: ledger },
        { provide: getRepositoryToken(MarketplaceLedgerEntry), useValue: ledgerEntries },
        { provide: getRepositoryToken(InstructorEarning), useValue: earningsRepo },
      ],
    }).compile();
    service = module.get(BalanceService);
  });

  it('combines the derived ledger balance with the outstanding shortfall', async () => {
    ledger.deriveBalance.mockResolvedValue({
      currency: 'EGP',
      pendingMinor: 100,
      clearingMinor: 0,
      availableMinor: 500,
      requestedMinor: 0,
      paidOutMinor: 1000,
      reversedMinor: 0,
    });
    qb.getRawOne.mockResolvedValue({ total: '250' });

    const balance = await service.getBalance('instructor-1', 'EGP');

    expect(balance.availableMinor).toBe(500);
    expect(balance.shortfallMinor).toBe(250);
  });

  it('sums only DEBIT refund_shortfall entries for this instructor/currency', async () => {
    qb.getRawOne.mockResolvedValue({ total: '0' });
    await service.getShortfall('instructor-1', 'EGP');

    expect(qb.andWhere).toHaveBeenCalledWith('l.entry_type = :type', {
      type: MarketplaceLedgerEntryType.REFUND_SHORTFALL,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('l.direction = :direction', {
      direction: MarketplaceLedgerDirection.DEBIT,
    });
  });

  it('returns zero when no shortfall rows exist', async () => {
    qb.getRawOne.mockResolvedValue(undefined);
    const shortfall = await service.getShortfall('instructor-1', 'EGP');
    expect(shortfall).toBe(0);
  });

  it('records the shortfall in full through the caller-provided manager, never reduced', async () => {
    const manager = {} as never;
    await service.recordShortfall(manager, 'instructor-1', 7500, 'EGP', 'refund-1');

    expect(ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({
        instructorId: 'instructor-1',
        entryType: MarketplaceLedgerEntryType.REFUND_SHORTFALL,
        amountMinor: 7500,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.DEBIT,
        reference: 'refund:refund-1:shortfall',
      }),
      manager,
    );
  });

  describe('getAllBalances (T164)', () => {
    it('derives a balance independently for every currency the instructor has ever earned in — never merged', async () => {
      earningsRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ currency: 'EGP' }, { currency: 'USD' }]),
      });
      ledger.deriveBalance.mockImplementation(async (_id: string, currency: string) => ({
        currency,
        pendingMinor: 0,
        clearingMinor: 0,
        availableMinor: currency === 'EGP' ? 1000 : 2000,
        requestedMinor: 0,
        paidOutMinor: 0,
        reversedMinor: 0,
      }));
      qb.getRawOne.mockResolvedValue({ total: '0' });

      const balances = await service.getAllBalances('instructor-1');

      expect(balances).toHaveLength(2);
      expect(balances.find((b) => b.currency === 'EGP')?.availableMinor).toBe(1000);
      expect(balances.find((b) => b.currency === 'USD')?.availableMinor).toBe(2000);
    });

    it('returns an empty array for an instructor with no earnings in any currency', async () => {
      const balances = await service.getAllBalances('instructor-1');
      expect(balances).toEqual([]);
    });
  });
});
