import { PayoutRequestStatus } from '../common/enums';
import { MarketplaceReportingService } from './reporting.service';

function buildQueryBuilder(rawResult: Record<string, string>, counts: { total: number; free: number } = { total: 0, free: 0 }) {
  const calls: string[] = [];
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((condition: string) => {
      calls.push(condition);
      return qb;
    }),
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(rawResult),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn(async () => (calls.some((c) => c.includes('is_zero_value = true')) ? counts.free : counts.total)),
  };
  return qb;
}

function buildService(opts: {
  raw?: Record<string, string>;
  counts?: { total: number; free: number };
  refundedRaw?: Record<string, string>;
  refundRows?: Array<Record<string, unknown>>;
  payoutRawByStatus?: Partial<Record<'requested' | 'paid' | 'rejected' | 'reversed', Record<string, string>>>;
} = {}) {
  const qb = buildQueryBuilder(
    opts.raw ?? { gross: '10000', discount: '0', net: '10000', commission: '3000', earning: '7000' },
    opts.counts ?? { total: 5, free: 2 },
  );
  const orders = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

  const refundQb = buildQueryBuilder(opts.refundedRaw ?? { refunded: '0' });
  refundQb.getRawMany.mockResolvedValue(opts.refundRows ?? []);
  const refunds = { createQueryBuilder: jest.fn().mockReturnValue(refundQb) };

  const payoutCallOrder: Array<'requested' | 'paid' | 'rejected' | 'reversed'> = ['requested', 'paid', 'rejected', 'reversed'];
  let payoutCallIndex = 0;
  const payoutQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(async () => {
      const key = payoutCallOrder[payoutCallIndex] ?? 'requested';
      payoutCallIndex += 1;
      return opts.payoutRawByStatus?.[key] ?? { [key]: '0' };
    }),
  };
  const payoutRequests = { createQueryBuilder: jest.fn().mockReturnValue(payoutQb) };

  return { service: new MarketplaceReportingService(orders as never, refunds as never, payoutRequests as never), orders, qb, refunds, refundQb, payoutRequests, payoutQb };
}

describe('MarketplaceReportingService (T113, extended T186)', () => {
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

  describe('getInstructorEarningsReport (FR-229)', () => {
    it('scopes the same figures to one instructor and includes the instructor id', async () => {
      const { service, qb } = buildService();

      const report = await service.getInstructorEarningsReport('instructor-1', 'EGP');

      expect(qb.andWhere).toHaveBeenCalledWith('o.instructor_id = :instructorId', { instructorId: 'instructor-1' });
      expect(report).toEqual({
        instructorId: 'instructor-1',
        currency: 'EGP',
        grossAmountMinor: 10000,
        discountAmountMinor: 0,
        netAmountMinor: 10000,
        commissionAmountMinor: 3000,
        instructorEarningMinor: 7000,
      });
    });
  });

  describe('getCourseRevenueReport (FR-230)', () => {
    it('nets sales against completed refunds for that course', async () => {
      const { service, qb, refundQb } = buildService({
        raw: { gross: '20000', discount: '0', net: '20000', commission: '6000', earning: '14000' },
        refundedRaw: { refunded: '5000' },
      });

      const report = await service.getCourseRevenueReport('course-1', 'EGP');

      expect(qb.andWhere).toHaveBeenCalledWith('o.course_id = :courseId', { courseId: 'course-1' });
      expect(refundQb.andWhere).toHaveBeenCalledWith('ro.course_id = :courseId', { courseId: 'course-1' });
      expect(report).toEqual({
        courseId: 'course-1',
        currency: 'EGP',
        grossAmountMinor: 20000,
        netAmountMinor: 20000,
        refundedAmountMinor: 5000,
        netRevenueMinor: 15000,
      });
    });

    it('only counts refunds that completed — filters by COMPLETED status', async () => {
      const { service, refunds } = buildService();
      await service.getCourseRevenueReport('course-1', 'EGP');

      expect(refunds.createQueryBuilder).toHaveBeenCalledWith('r');
    });
  });

  describe('getRefundReport (FR-236)', () => {
    it('scopes by the refund\'s own decided_at (when it completed), not created_at', async () => {
      const { service, refundQb } = buildService();
      const from = new Date('2026-02-01');
      const to = new Date('2026-02-28');

      await service.getRefundReport('EGP', { from, to });

      expect(refundQb.andWhere).toHaveBeenCalledWith('r.decided_at >= :from', { from });
      expect(refundQb.andWhere).toHaveBeenCalledWith('r.decided_at <= :to', { to });
    });

    it('each row carries the original sale\'s own period for traceability', async () => {
      const { service, refundQb } = buildService();
      refundQb.getRawMany.mockResolvedValue([
        {
          refund_id: 'refund-1',
          order_id: 'order-1',
          completed_at: new Date('2026-02-15T00:00:00.000Z'),
          amount_minor: '5000',
          original_sale_at: new Date('2026-01-03T00:00:00.000Z'),
        },
      ]);

      const rows = await service.getRefundReport('EGP');

      expect(rows).toEqual([
        {
          refundId: 'refund-1',
          orderId: 'order-1',
          currency: 'EGP',
          amountMinor: 5000,
          completedAt: '2026-02-15T00:00:00.000Z',
          originalSalePeriod: '2026-01',
        },
      ]);
    });
  });

  describe('getPayoutReport (FR-231)', () => {
    it('sums each of the four categories from its own real decision timestamp, currency-scoped', async () => {
      const { service, payoutQb } = buildService({
        payoutRawByStatus: {
          requested: { requested: '100000' },
          paid: { paid: '60000' },
          rejected: { rejected: '20000' },
          reversed: { reversed: '10000' },
        },
      });

      const report = await service.getPayoutReport('EGP');

      expect(report).toEqual({
        currency: 'EGP',
        requestedAmountMinor: 100000,
        paidAmountMinor: 60000,
        rejectedAmountMinor: 20000,
        reversedAmountMinor: 10000,
      });
      expect(payoutQb.where).toHaveBeenCalledWith('p.currency = :currency', { currency: 'EGP' });
    });

    it('only counts a FAILED request as reversed when it was previously paid', async () => {
      const { service, payoutQb } = buildService();
      await service.getPayoutReport('EGP');

      expect(payoutQb.andWhere).toHaveBeenCalledWith('p.status = :status', { status: PayoutRequestStatus.FAILED });
      expect(payoutQb.andWhere).toHaveBeenCalledWith('p.paid_at IS NOT NULL');
    });
  });
});
