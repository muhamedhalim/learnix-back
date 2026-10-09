import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType } from '../common/enums';
import { BalanceService } from './balance.service';
import { MarketplaceLedgerEntry } from './entities/marketplace-ledger-entry.entity';
import { LedgerService } from './ledger.service';

describe('BalanceService (T139)', () => {
  let service: BalanceService;
  let ledger: { deriveBalance: jest.Mock; deriveBalancesGrouped: jest.Mock; post: jest.Mock };
  let qb: { where: jest.Mock; andWhere: jest.Mock; select: jest.Mock; getRawOne: jest.Mock };
  let ledgerEntries: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    ledger = {
      deriveBalance: jest.fn(),
      deriveBalancesGrouped: jest.fn().mockResolvedValue([]),
      post: jest.fn(),
    };
    qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
    } as never;
    ledgerEntries = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

    const module = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: LedgerService, useValue: ledger },
        { provide: getRepositoryToken(MarketplaceLedgerEntry), useValue: ledgerEntries },
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
      const grouped = (currency: string, availableMinor: number) => ({
        instructorId: 'instructor-1',
        balance: {
          currency,
          pendingMinor: 0,
          clearingMinor: 0,
          availableMinor,
          requestedMinor: 0,
          paidOutMinor: 0,
          reversedMinor: 0,
        },
        shortfallMinor: 0,
      });
      ledger.deriveBalancesGrouped.mockResolvedValue([grouped('EGP', 1000), grouped('USD', 2000)]);

      const balances = await service.getAllBalances('instructor-1');

      expect(balances).toHaveLength(2);
      expect(balances.find((b) => b.currency === 'EGP')?.availableMinor).toBe(1000);
      expect(balances.find((b) => b.currency === 'USD')?.availableMinor).toBe(2000);
    });

    it('returns an empty array for an instructor with no earnings in any currency', async () => {
      const balances = await service.getAllBalances('instructor-1');
      expect(balances).toEqual([]);
    });

    it('T067: narrows the grouped derivation to the instructor and keeps the original row shape', async () => {
      ledger.deriveBalancesGrouped.mockResolvedValue([
        {
          instructorId: 'instructor-1',
          balance: {
            currency: 'EGP',
            pendingMinor: 1,
            clearingMinor: 2,
            availableMinor: 3,
            requestedMinor: 4,
            paidOutMinor: 5,
            reversedMinor: 6,
          },
          shortfallMinor: 7,
        },
      ]);

      const balances = await service.getAllBalances('instructor-1');

      expect(ledger.deriveBalancesGrouped).toHaveBeenCalledTimes(1);
      expect(ledger.deriveBalancesGrouped).toHaveBeenCalledWith({ instructorId: 'instructor-1' });
      expect(ledger.deriveBalance).not.toHaveBeenCalled();
      expect(balances).toEqual([
        {
          currency: 'EGP',
          pendingMinor: 1,
          clearingMinor: 2,
          availableMinor: 3,
          requestedMinor: 4,
          paidOutMinor: 5,
          reversedMinor: 6,
          shortfallMinor: 7,
        },
      ]);
      expect(Object.keys(balances[0] ?? {})).not.toContain('instructorId');
    });
  });

  describe('getBalancesGrouped (T067)', () => {
    it('is unfiltered by default and tags every row with its instructor', async () => {
      ledger.deriveBalancesGrouped.mockResolvedValue([
        {
          instructorId: 'i-1',
          balance: {
            currency: 'EGP',
            pendingMinor: 0,
            clearingMinor: 0,
            availableMinor: -5,
            requestedMinor: 0,
            paidOutMinor: 0,
            reversedMinor: 0,
          },
          shortfallMinor: 9,
        },
      ]);

      const rows = await service.getBalancesGrouped();

      expect(ledger.deriveBalancesGrouped).toHaveBeenCalledWith({});
      expect(rows).toEqual([
        expect.objectContaining({ instructorId: 'i-1', currency: 'EGP', availableMinor: -5, shortfallMinor: 9 }),
      ]);
    });
  });
});
