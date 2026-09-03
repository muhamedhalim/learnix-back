import { InstructorEarningStatus, MarketplaceLedgerDirection, MarketplaceLedgerEntryType, PayoutRequestStatus } from '../common/enums';
import { MarketplaceExportService } from './export.service';

function buildQb(rows: unknown[]) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
}

describe('MarketplaceExportService (T189, FR-232)', () => {
  it('exports sales as CSV with a UTF-8 BOM and a header row', async () => {
    const orders = { createQueryBuilder: jest.fn().mockReturnValue(buildQb([
      { order_number: 'MP-1', course_title_snapshot: 'Course "A"', instructor_id: 'i1', paid_at: new Date('2026-01-01T00:00:00.000Z'), currency: 'EGP', gross_amount_minor: 1000, discount_amount_minor: 0, net_amount_minor: 1000, commission_amount_minor: 300, instructor_earning_minor: 700 },
    ])) };
    const earnings = { createQueryBuilder: jest.fn() };
    const payoutRequests = { createQueryBuilder: jest.fn() };
    const ledger = { listEntriesAdmin: jest.fn() };
    const service = new MarketplaceExportService(orders as never, earnings as never, payoutRequests as never, ledger as never);

    const csv = await service.exportSalesCsv('EGP');

    expect(csv.startsWith('﻿order_number,')).toBe(true);
    expect(csv).toContain('MP-1');
    // A field containing a double-quote must be escaped per RFC-4180.
    expect(csv).toContain('"Course ""A"""');
  });

  it('exports earnings scoped by currency and date range', async () => {
    const qb = buildQb([
      { id: 'e1', instructor_id: 'i1', order_id: 'o1', currency: 'EGP', gross_amount_minor: 1000, commission_amount_minor: 300, net_amount_minor: 700, status: InstructorEarningStatus.AVAILABLE_BALANCE, available_at: new Date() },
    ]);
    const earnings = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const orders = { createQueryBuilder: jest.fn() };
    const payoutRequests = { createQueryBuilder: jest.fn() };
    const ledger = { listEntriesAdmin: jest.fn() };
    const service = new MarketplaceExportService(orders as never, earnings as never, payoutRequests as never, ledger as never);
    const from = new Date('2026-01-01');
    const to = new Date('2026-01-31');

    const csv = await service.exportEarningsCsv('EGP', { from, to });

    expect(qb.andWhere).toHaveBeenCalledWith('e.created_at >= :from', { from });
    expect(qb.andWhere).toHaveBeenCalledWith('e.created_at <= :to', { to });
    expect(csv).toContain('e1');
  });

  it('exports ledger entries via LedgerService.listEntriesAdmin, normalizing the raw bigint-as-string amount', async () => {
    const orders = { createQueryBuilder: jest.fn() };
    const earnings = { createQueryBuilder: jest.fn() };
    const payoutRequests = { createQueryBuilder: jest.fn() };
    const ledger = {
      listEntriesAdmin: jest.fn().mockResolvedValue({
        data: [{ id: 'l1', instructor_id: 'i1', order_id: 'o1', entry_type: MarketplaceLedgerEntryType.PAYOUT, direction: MarketplaceLedgerDirection.CREDIT, amount_minor: '5000', currency: 'EGP', reference: 'ref-1', created_at: new Date('2026-01-05T00:00:00.000Z') }],
        meta: { page: 1, limit: 10000, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: false },
      }),
    };
    const service = new MarketplaceExportService(orders as never, earnings as never, payoutRequests as never, ledger as never);

    const csv = await service.exportLedgerCsv('EGP');

    expect(ledger.listEntriesAdmin).toHaveBeenCalledWith(expect.objectContaining({ currency: 'EGP', limit: 10000 }));
    expect(csv).toContain('5000');
  });

  it('exports payout requests scoped by currency', async () => {
    const qb = buildQb([
      { request_number: 'PR-1', instructor_id: 'i1', currency: 'EGP', amount_minor: 50000, status: PayoutRequestStatus.PAID, requested_at: new Date(), paid_at: new Date(), payout_reference: 'TXN-1', reason: null },
    ]);
    const payoutRequests = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const orders = { createQueryBuilder: jest.fn() };
    const earnings = { createQueryBuilder: jest.fn() };
    const ledger = { listEntriesAdmin: jest.fn() };
    const service = new MarketplaceExportService(orders as never, earnings as never, payoutRequests as never, ledger as never);

    const csv = await service.exportPayoutsCsv('EGP');

    expect(qb.where).toHaveBeenCalledWith('p.currency = :currency', { currency: 'EGP' });
    expect(csv).toContain('PR-1');
    expect(csv).toContain('TXN-1');
  });
});
