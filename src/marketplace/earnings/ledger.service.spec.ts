import type { Repository } from 'typeorm';

import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType } from '../common/enums';
import { MarketplaceMoneyService } from '../common/money.service';
import { InstructorEarning } from './entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from './entities/marketplace-ledger-entry.entity';
import { LedgerService } from './ledger.service';

function buildService(): {
  service: LedgerService;
  entries: jest.Mocked<Repository<MarketplaceLedgerEntry>>;
} {
  const store = new Map<string, MarketplaceLedgerEntry>();
  const entries = {
    create: jest.fn((data: Partial<MarketplaceLedgerEntry>) => data as MarketplaceLedgerEntry),
    save: jest.fn(async (entry: MarketplaceLedgerEntry) => {
      if (store.has(entry.reference)) {
        const error = new Error('duplicate key value violates unique constraint "UQ_mp_ledger_reference"');
        (error as unknown as { code: string }).code = '23505';
        throw error;
      }
      const saved = { ...entry, id: `id-${store.size + 1}` };
      store.set(entry.reference, saved);
      return saved;
    }),
    findOne: jest.fn(async ({ where }: { where: { reference: string } }) => store.get(where.reference) ?? null),
  } as unknown as jest.Mocked<Repository<MarketplaceLedgerEntry>>;
  const earnings = {} as jest.Mocked<Repository<InstructorEarning>>;
  const money = new MarketplaceMoneyService({ resolve: jest.fn() } as never);
  return { service: new LedgerService(entries, earnings, money), entries };
}

describe('LedgerService', () => {
  describe('buildReference', () => {
    it('is deterministic for the same (event type, order id, sequence)', () => {
      const { service } = buildService();
      const a = service.buildReference('course_sale', 'order-1', 1);
      const b = service.buildReference('course_sale', 'order-1', 1);
      expect(a).toBe(b);
    });

    it('differs when any input differs', () => {
      const { service } = buildService();
      const base = service.buildReference('course_sale', 'order-1', 1);
      expect(service.buildReference('refund', 'order-1', 1)).not.toBe(base);
      expect(service.buildReference('course_sale', 'order-2', 1)).not.toBe(base);
      expect(service.buildReference('course_sale', 'order-1', 2)).not.toBe(base);
    });
  });

  describe('post', () => {
    it('appends a new entry', async () => {
      const { service } = buildService();
      const entry = await service.post({
        instructorId: 'instructor-1',
        orderId: 'order-1',
        entryType: MarketplaceLedgerEntryType.COURSE_SALE,
        amountMinor: 1000,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.CREDIT,
        reference: 'course_sale:order-1:1',
      });
      expect(entry.reference).toBe('course_sale:order-1:1');
    });

    it('is idempotent: replaying the same reference is a no-op that returns the original entry, never a duplicate or a thrown error', async () => {
      const { service, entries } = buildService();
      const input = {
        instructorId: 'instructor-1',
        orderId: 'order-1',
        entryType: MarketplaceLedgerEntryType.COURSE_SALE,
        amountMinor: 1000,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.CREDIT,
        reference: 'course_sale:order-1:1',
      };
      const first = await service.post(input);
      const second = await service.post(input);

      expect(second).toEqual(first);
      expect(entries.save).toHaveBeenCalledTimes(2);
      expect(entries.findOne).toHaveBeenCalledTimes(1);
    });

    it('posts through a transactional manager when one is supplied, not through its own repository (settlement atomicity, FR-099)', async () => {
      const { service, entries } = buildService();
      const managerRepo = {
        create: jest.fn((data: Record<string, unknown>) => data),
        save: jest.fn(async (entry: Record<string, unknown>) => ({ id: 'tx-id-1', ...entry })),
        findOne: jest.fn(),
      };
      const manager = { getRepository: jest.fn().mockReturnValue(managerRepo) } as never;

      const result = await service.post(
        {
          instructorId: 'instructor-1',
          orderId: 'order-1',
          entryType: MarketplaceLedgerEntryType.COURSE_SALE,
          amountMinor: 1000,
          currency: 'EGP',
          direction: MarketplaceLedgerDirection.CREDIT,
          reference: 'course_sale:order-1:1',
        },
        manager,
      );

      expect(managerRepo.save).toHaveBeenCalled();
      expect(entries.save).not.toHaveBeenCalled();
      expect(result.id).toBe('tx-id-1');
    });

    it('propagates a genuinely different failure rather than swallowing it', async () => {
      const { service, entries } = buildService();
      entries.save.mockRejectedValueOnce(new Error('connection lost'));
      await expect(
        service.post({
          instructorId: 'instructor-1',
          orderId: 'order-1',
          entryType: MarketplaceLedgerEntryType.COURSE_SALE,
          amountMinor: 1000,
          currency: 'EGP',
          direction: MarketplaceLedgerDirection.CREDIT,
          reference: 'course_sale:order-1:1',
        }),
      ).rejects.toThrow('connection lost');
    });

    it('refuses a zero (or negative) amount before any write — a zero-value order has no financial trace to post (T112, FR-169)', async () => {
      const { service, entries } = buildService();
      await expect(
        service.post({
          instructorId: 'instructor-1',
          orderId: 'order-1',
          entryType: MarketplaceLedgerEntryType.COURSE_SALE,
          amountMinor: 0,
          currency: 'EGP',
          direction: MarketplaceLedgerDirection.CREDIT,
          reference: 'course_sale:order-1:1',
        }),
      ).rejects.toThrow();
      expect(entries.save).not.toHaveBeenCalled();
    });
  });

  describe('createEarning', () => {
    function buildManager() {
      const repo = {
        create: jest.fn((data: Record<string, unknown>) => data),
        save: jest.fn(async (entry: Record<string, unknown>) => ({ id: 'earning-1', ...entry })),
      };
      return { manager: { getRepository: jest.fn().mockReturnValue(repo) } as never, repo };
    }

    it('creates an earning through the caller-supplied manager, never its own repository (FR-099)', async () => {
      const { service, entries } = buildService();
      const { manager, repo } = buildManager();

      const earning = await service.createEarning(
        {
          instructorId: 'instructor-1',
          orderId: 'order-1',
          grossAmountMinor: 1000,
          commissionAmountMinor: 300,
          netAmountMinor: 700,
          currency: 'EGP',
          commissionBps: 3000,
          availableAt: new Date(),
        },
        manager,
      );

      expect(repo.save).toHaveBeenCalled();
      expect(entries.save).not.toHaveBeenCalled();
      expect(earning.id).toBe('earning-1');
    });

    it('refuses a zero (or negative) gross amount before any write — no earning for a zero-value order (T112, FR-114)', async () => {
      const { service } = buildService();
      const { manager, repo } = buildManager();

      await expect(
        service.createEarning(
          {
            instructorId: 'instructor-1',
            orderId: 'order-1',
            grossAmountMinor: 0,
            commissionAmountMinor: 0,
            netAmountMinor: 0,
            currency: 'EGP',
            commissionBps: 3000,
            availableAt: new Date(),
          },
          manager,
        ),
      ).rejects.toThrow();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('listEntriesAdmin (T192, FR-170)', () => {
    function buildAdminQueryService(rows: MarketplaceLedgerEntry[], total: number) {
      const qb = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
      };
      const entries = { createQueryBuilder: jest.fn().mockReturnValue(qb) } as unknown as jest.Mocked<Repository<MarketplaceLedgerEntry>>;
      const earnings = {} as jest.Mocked<Repository<InstructorEarning>>;
      const money = new MarketplaceMoneyService({ resolve: jest.fn() } as never);
      return { service: new LedgerService(entries, earnings, money), qb };
    }

    it('is not scoped to one instructor by default — every instructor\'s entries', async () => {
      const { service, qb } = buildAdminQueryService([], 0);
      await service.listEntriesAdmin();
      expect(qb.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('instructor_id'), expect.anything());
    });

    it('applies every optional filter when provided', async () => {
      const { service, qb } = buildAdminQueryService([], 0);
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');

      await service.listEntriesAdmin({
        instructorId: 'instructor-1',
        entryType: MarketplaceLedgerEntryType.PAYOUT,
        currency: 'EGP',
        from,
        to,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('l.instructor_id = :instructorId', { instructorId: 'instructor-1' });
      expect(qb.andWhere).toHaveBeenCalledWith('l.entry_type = :entryType', { entryType: MarketplaceLedgerEntryType.PAYOUT });
      expect(qb.andWhere).toHaveBeenCalledWith('l.currency = :currency', { currency: 'EGP' });
      expect(qb.andWhere).toHaveBeenCalledWith('l.created_at >= :from', { from });
      expect(qb.andWhere).toHaveBeenCalledWith('l.created_at <= :to', { to });
    });

    it('paginates newest first', async () => {
      const row = { id: 'ledger-1' } as MarketplaceLedgerEntry;
      const { service, qb } = buildAdminQueryService([row], 1);

      const result = await service.listEntriesAdmin({ page: 2, limit: 10 });

      expect(qb.orderBy).toHaveBeenCalledWith('l.created_at', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(result.data).toEqual([row]);
      expect(result.meta.total).toBe(1);
    });
  });

  describe('deriveBalancesGrouped (T067)', () => {
    function groupedQb(rows: unknown[]): Record<string, jest.Mock> {
      return {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
    }

    function build(earningRows: unknown[], entryRows: unknown[]) {
      const earningsQb = groupedQb(earningRows);
      const entriesQb = groupedQb(entryRows);
      const entries = { createQueryBuilder: jest.fn().mockReturnValue(entriesQb) };
      const earnings = { createQueryBuilder: jest.fn().mockReturnValue(earningsQb) };
      const money = new MarketplaceMoneyService({ resolve: jest.fn() } as never);
      const service = new LedgerService(entries as never, earnings as never, money);
      return { service, earningsQb, entriesQb, entries, earnings };
    }

    const earningRow = (over: Record<string, string> = {}): Record<string, string> => ({
      instructor_id: 'i-1',
      currency: 'EGP',
      pending: '3000',
      clearing: '500',
      requested: '1000',
      available: '1000',
      ...over,
    });

    it('issues exactly one statement per table and never joins them', async () => {
      const { service, earningsQb, entriesQb, entries, earnings } = build([earningRow()], []);

      await service.deriveBalancesGrouped();

      expect(earnings.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(entries.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(earningsQb['getRawMany']).toHaveBeenCalledTimes(1);
      expect(entriesQb['getRawMany']).toHaveBeenCalledTimes(1);
      // The mocks have no join methods: a join would throw. Currency is in every GROUP BY.
      expect(earningsQb['groupBy']).toHaveBeenCalledWith('e.instructor_id');
      expect(earningsQb['addGroupBy']).toHaveBeenCalledWith('e.currency');
      expect(entriesQb['groupBy']).toHaveBeenCalledWith('l.instructor_id');
      expect(entriesQb['addGroupBy']).toHaveBeenCalledWith('l.currency');
    });

    it('binds enum values rather than literals', async () => {
      const { service, earningsQb, entriesQb } = build([], []);

      await service.deriveBalancesGrouped();

      expect(earningsQb['setParameters']).toHaveBeenCalledWith({
        pending: 'pending_earnings',
        clearance: 'refund_clearance',
        requested: 'payout_requested',
        processing: 'processing',
        available: 'available_balance',
      });
      expect(entriesQb['setParameters']).toHaveBeenCalledWith(
        expect.objectContaining({
          adjustment: MarketplaceLedgerEntryType.MANUAL_ADJUSTMENT,
          credit: MarketplaceLedgerDirection.CREDIT,
          debit: MarketplaceLedgerDirection.DEBIT,
          payout: MarketplaceLedgerEntryType.PAYOUT,
          payoutReversal: MarketplaceLedgerEntryType.PAYOUT_REVERSAL,
          refund: MarketplaceLedgerEntryType.REFUND,
          shortfall: MarketplaceLedgerEntryType.REFUND_SHORTFALL,
        }),
      );
    });

    it('combines each pair with its own ledger row; an absent ledger row means zeros', async () => {
      const { service } = build(
        [earningRow(), earningRow({ currency: 'KWD', pending: '50', clearing: '0', requested: '0', available: '0' })],
        [
          {
            instructor_id: 'i-1',
            currency: 'EGP',
            adjustment_credit: '425',
            adjustment_debit: '150',
            payout: '5070',
            payout_reversal: '1200',
            refund: '833',
            shortfall: '100',
          },
        ],
      );

      const rows = await service.deriveBalancesGrouped();

      expect(rows).toEqual([
        {
          instructorId: 'i-1',
          balance: {
            currency: 'EGP',
            pendingMinor: 3000,
            clearingMinor: 500,
            availableMinor: 1000 + 425 - 150,
            requestedMinor: 1000,
            paidOutMinor: 5070 - 1200,
            reversedMinor: 833,
          },
          shortfallMinor: 100,
        },
        {
          instructorId: 'i-1',
          balance: {
            currency: 'KWD',
            pendingMinor: 50,
            clearingMinor: 0,
            availableMinor: 0,
            requestedMinor: 0,
            paidOutMinor: 0,
            reversedMinor: 0,
          },
          shortfallMinor: 0,
        },
      ]);
    });

    it('never reports a ledger-only currency (the pair universe is the earnings table)', async () => {
      const { service } = build(
        [earningRow()],
        [{ instructor_id: 'i-1', currency: 'GBP', adjustment_credit: '999', adjustment_debit: '0', payout: '0', payout_reversal: '0', refund: '0', shortfall: '11' }],
      );

      const rows = await service.deriveBalancesGrouped();

      expect(rows.map((row) => row.balance.currency)).toEqual(['EGP']);
      expect(rows[0]?.balance.availableMinor).toBe(1000);
      expect(rows[0]?.shortfallMinor).toBe(0);
    });

    it('keeps a negative available balance negative', async () => {
      const { service } = build(
        [earningRow({ available: '100' })],
        [{ instructor_id: 'i-1', currency: 'EGP', adjustment_credit: '0', adjustment_debit: '400', payout: '0', payout_reversal: '0', refund: '0', shortfall: '0' }],
      );

      const [row] = await service.deriveBalancesGrouped();

      expect(row?.balance.availableMinor).toBe(-300);
    });

    it('narrows both statements to one instructor when asked', async () => {
      const { service, earningsQb, entriesQb } = build([], []);

      await service.deriveBalancesGrouped({ instructorId: 'i-9' });

      expect(earningsQb['where']).toHaveBeenCalledWith('e.instructor_id = :instructorId', { instructorId: 'i-9' });
      expect(entriesQb['where']).toHaveBeenCalledWith('l.instructor_id = :instructorId', { instructorId: 'i-9' });
    });

    it('does not filter when called without an instructor', async () => {
      const { service, earningsQb, entriesQb } = build([], []);

      await service.deriveBalancesGrouped();

      expect(earningsQb['where']).not.toHaveBeenCalled();
      expect(entriesQb['where']).not.toHaveBeenCalled();
    });
  });

});
