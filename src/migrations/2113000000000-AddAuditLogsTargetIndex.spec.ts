import { AddAuditLogsTargetIndex2113000000000 } from './2113000000000-AddAuditLogsTargetIndex';

describe('AddAuditLogsTargetIndex2113000000000', () => {
  it('creates and drops exactly the composite target index, concurrently, outside a transaction', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddAuditLogsTargetIndex2113000000000();

    await migration.up({ query } as never);
    const up = query.mock.calls.map(([sql]) => String(sql));
    query.mockClear();
    await migration.down({ query } as never);
    const down = query.mock.calls.map(([sql]) => String(sql));

    expect(migration.transaction).toBe(false);
    expect(up).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_target_created" ON "audit_logs" ("target_type", "target_id", "created_at")',
    ]);
    expect(down).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_audit_logs_target_created"']);
  });
});
