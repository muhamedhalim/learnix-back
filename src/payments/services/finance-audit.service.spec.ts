import { DataSource } from 'typeorm';

import { FinanceAuditFilterDto } from '../dto';
import { FinanceAuditService } from './finance-audit.service';

describe('FinanceAuditService', () => {
  const build = (rows: unknown[] = [], count = 0) => {
    const query = jest
      .fn()
      .mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count }]) : Promise.resolve(rows),
      );
    return {
      query,
      service: new FinanceAuditService({ query } as unknown as DataSource),
    };
  };

  const filter = (overrides: Partial<FinanceAuditFilterDto> = {}): FinanceAuditFilterDto =>
    ({ teacher_id: 'teacher-1', page: 1, limit: 20, ...overrides }) as FinanceAuditFilterDto;

  it('scopes every record type to the requested teacher', async () => {
    const { service, query } = build();

    await service.list(filter());

    const [sql, params] = query.mock.calls[0];
    // Each branch resolves the audit row to a teacher through its own join.
    expect(sql).toContain("log.resource_type = 'settlement' AND settlement.teacher_id = $1");
    expect(sql).toContain("log.resource_type = 'refund' AND refund_order.teacher_id = $1");
    expect(sql).toContain("log.resource_type = 'order' AND sale.teacher_id = $1");
    expect(sql).toContain('submission_order.teacher_id = $1');
    expect(params[0]).toBe('teacher-1');
  });

  it('never emits an unscoped branch that could leak another teacher', async () => {
    const { service, query } = build();

    await service.list(filter());

    const [sql] = query.mock.calls[0];
    const branches = sql.split('UNION ALL');
    expect(branches).toHaveLength(4);
    for (const branch of branches) {
      expect(branch).toContain('teacher_id = $1');
    }
  });

  it('binds filters positionally rather than interpolating them', async () => {
    const { service, query } = build();

    await service.list(
      filter({
        resource_type: 'settlement',
        action: 'settlement_paid',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      }),
    );

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('scoped.resource_type = $2');
    expect(sql).toContain('scoped.action = $3');
    expect(sql).toContain('scoped.created_at >= $4');
    expect(sql).toContain('scoped.created_at < $5');
    expect(params).toEqual([
      'teacher-1',
      'settlement',
      'settlement_paid',
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ]);
    // A quoted literal would mean the value was interpolated into the SQL.
    expect(sql).not.toContain('settlement_paid');
  });

  it('caps the page size at 100 regardless of the requested limit', async () => {
    const { service, query } = build();

    await service.list(filter({ limit: 5000 }));

    const paginatedParams = query.mock.calls[1][1];
    expect(paginatedParams.at(-2)).toBe(100);
  });

  it('offsets by page and returns coherent pagination metadata', async () => {
    const { service, query } = build([], 45);

    const result = await service.list(filter({ page: 3, limit: 20 }));

    const paginatedParams = query.mock.calls[1][1];
    expect(paginatedParams.at(-1)).toBe(40);
    expect(result.meta).toEqual({
      page: 3,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasNextPage: false,
      hasPrevPage: true,
    });
  });

  it('orders newest first so the trail reads as a timeline', async () => {
    const { service, query } = build();

    await service.list(filter());

    expect(query.mock.calls[1][0]).toContain('ORDER BY scoped.created_at DESC');
  });

  it('does not expose ip_address, which finance services never populate', async () => {
    const { service, query } = build();

    await service.list(filter());

    expect(query.mock.calls[1][0]).not.toContain('ip_address');
  });

  it('resolves the acting admin without dropping system-generated rows', async () => {
    const { service, query } = build();

    await service.list(filter());

    // A LEFT JOIN keeps rows whose actor_id is null (cron/webhook-driven).
    expect(query.mock.calls[1][0]).toContain('LEFT JOIN users actor');
  });

  it('lists the distinct actions available for one teacher', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ action: 'settlement_created' }, { action: 'settlement_paid' }]);
    const service = new FinanceAuditService({ query } as unknown as DataSource);

    await expect(service.actions('teacher-1')).resolves.toEqual([
      'settlement_created',
      'settlement_paid',
    ]);
    expect(query.mock.calls[0][1]).toEqual(['teacher-1']);
  });
});
