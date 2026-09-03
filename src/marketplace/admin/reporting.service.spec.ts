import { MarketplaceReportingService } from './reporting.service';

function buildQueryBuilder(rawResult: Record<string, string>, counts: { total: number; free: number }) {
  const calls: string[] = [];
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((condition: string) => {
      calls.push(condition);
      return qb;
    }),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(rawResult),
    getCount: jest.fn(async () => (calls.some((c) => c.includes('is_zero_value = true')) ? counts.free : counts.total)),
  };
  return qb;
}

function buildService(opts: {
  raw?: Record<string, string>;
  counts?: { total: number; free: number };
} = {}) {
  const qb = buildQueryBuilder(
    opts.raw ?? { gross: '10000', discount: '0', net: '10000', commission: '3000', earning: '7000' },
    opts.counts ?? { total: 5, free: 2 },
  );
  const orders = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  return { service: new MarketplaceReportingService(orders as never), orders, qb };
}

describe('MarketplaceReportingService (T113)', () => {
  it('getRevenueSummary always filters out zero-value orders (FR-115, FR-228)', async () => {
    const { service, qb } = buildService();
    const summary = await service.getRevenueSummary('EGP');

    expect(qb.andWhere).toHaveBeenCalledWith('o.is_zero_value = false');
    expect(summary).toEqual({
      currency: 'EGP',
      grossAmountMinor: 10000,
      discountAmountMinor: 0,
      netAmountMinor: 10000,
      commissionAmountMinor: 3000,
      instructorEarningMinor: 7000,
    });
  });

  it('getAcquisitionSummary counts both paid and free enrollments — never excludes zero-value orders (FR-116, FR-228)', async () => {
    const { service } = buildService({ counts: { total: 5, free: 2 } });
    const summary = await service.getAcquisitionSummary();

    expect(summary).toEqual({ totalEnrollments: 5, paidEnrollments: 3, freeEnrollments: 2 });
  });

  it('scopes revenue by currency, never mixing figures across currencies', async () => {
    const { service, orders, qb } = buildService();
    await service.getRevenueSummary('USD');

    expect(orders.createQueryBuilder).toHaveBeenCalledWith('o');
    expect(qb.andWhere).toHaveBeenCalledWith('o.currency = :currency', { currency: 'USD' });
  });

  it('applies an optional date range to both revenue and acquisition queries', async () => {
    const { service, qb } = buildService();
    const from = new Date('2026-01-01');
    const to = new Date('2026-01-31');

    await service.getRevenueSummary('EGP', { from, to });

    expect(qb.andWhere).toHaveBeenCalledWith('o.paid_at >= :from', { from });
    expect(qb.andWhere).toHaveBeenCalledWith('o.paid_at <= :to', { to });
  });
});
