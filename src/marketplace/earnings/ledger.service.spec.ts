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
});
