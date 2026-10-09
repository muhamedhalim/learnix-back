import { ReconciliationService } from './reconciliation.service';

function buildQb(rows: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    subQuery: jest.fn(),
    from: jest.fn().mockReturnThis(),
    getQuery: jest.fn().mockReturnValue('SELECT 1'),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  qb.subQuery = jest.fn().mockReturnValue(qb);
  return qb;
}

describe('ReconciliationService (T165)', () => {
  let earningsRepo: { createQueryBuilder: jest.Mock };
  let ledgerRepo: { createQueryBuilder: jest.Mock };
  let balance: { getBalancesGrouped: jest.Mock };
  let service: ReconciliationService;

  beforeEach(() => {
    earningsRepo = { createQueryBuilder: jest.fn() };
    ledgerRepo = { createQueryBuilder: jest.fn().mockReturnValue(buildQb([])) };
    balance = { getBalancesGrouped: jest.fn().mockResolvedValue([]) };
    service = new ReconciliationService(earningsRepo as never, ledgerRepo as never, balance as never);
  });

  it('flags a negative derived available balance as critical (FR-173)', async () => {
    const emptyQb = buildQb([]);
    earningsRepo.createQueryBuilder.mockReturnValueOnce(emptyQb).mockReturnValueOnce(emptyQb);
    balance.getBalancesGrouped.mockResolvedValue([
      { instructorId: 'instructor-1', currency: 'EGP', availableMinor: -500 },
      { instructorId: 'instructor-2', currency: 'EGP', availableMinor: 0 },
      { instructorId: 'instructor-3', currency: 'KWD', availableMinor: 40 },
    ]);

    const report = await service.getDivergenceReport();

    expect(report.negative_available_balances).toEqual([
      { instructor_id: 'instructor-1', currency: 'EGP', available_minor: -500 },
    ]);

    const warnings = await (async () => {
      earningsRepo.createQueryBuilder.mockReturnValueOnce(emptyQb).mockReturnValueOnce(emptyQb);
      return service.getDivergenceWarnings();
    })();
    expect(warnings).toEqual([expect.objectContaining({ type: 'negative_available_balances', severity: 'critical', affected_count: 1 })]);
  });

  it('T067: derives every pair in one grouped call, never one balance per pair', async () => {
    const emptyQb = buildQb([]);
    earningsRepo.createQueryBuilder.mockReturnValue(emptyQb);
    balance.getBalancesGrouped.mockResolvedValue([
      { instructorId: 'i-1', currency: 'EGP', availableMinor: -1 },
      { instructorId: 'i-1', currency: 'KWD', availableMinor: -2 },
      { instructorId: 'i-2', currency: 'EGP', availableMinor: 10 },
    ]);

    const report = await service.getDivergenceReport();

    expect(balance.getBalancesGrouped).toHaveBeenCalledTimes(1);
    expect(balance.getBalancesGrouped).toHaveBeenCalledWith();
    expect(report.negative_available_balances).toEqual([
      { instructor_id: 'i-1', currency: 'EGP', available_minor: -1 },
      { instructor_id: 'i-1', currency: 'KWD', available_minor: -2 },
    ]);
  });

  it('reports clean when nothing diverges', async () => {
    const emptyQb = buildQb([]);
    earningsRepo.createQueryBuilder.mockReturnValue(emptyQb);

    const warnings = await service.getDivergenceWarnings();

    expect(warnings).toEqual([]);
  });

  it('flags an earning missing its COURSE_SALE ledger entry', async () => {
    const missingQb = buildQb([{ earning_id: 'earning-1', order_id: 'order-1' }]);
    const emptyQb = buildQb([]);
    earningsRepo.createQueryBuilder.mockReturnValueOnce(missingQb).mockReturnValueOnce(emptyQb);

    const report = await service.getDivergenceReport();

    expect(report.earnings_missing_sale_entry).toEqual([{ earning_id: 'earning-1', order_id: 'order-1' }]);
  });

  it('flags a manual adjustment missing its actor or reason as critical (FR-168 defense in depth)', async () => {
    earningsRepo.createQueryBuilder.mockReturnValue(buildQb([]));
    ledgerRepo.createQueryBuilder.mockReturnValue(buildQb([{ id: 'ledger-1', created_by: null }]));

    const report = await service.getDivergenceReport();

    expect(report.manual_adjustments_missing_actor_or_reason).toEqual([{ id: 'ledger-1', created_by: null }]);
  });
});
