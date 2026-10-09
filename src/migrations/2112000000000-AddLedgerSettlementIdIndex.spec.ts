import { AddLedgerSettlementIdIndex2112000000000 } from './2112000000000-AddLedgerSettlementIdIndex';

describe('AddLedgerSettlementIdIndex2112000000000', () => {
  it('creates and drops exactly the partial settlement_id index, concurrently, outside a transaction', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddLedgerSettlementIdIndex2112000000000();

    await migration.up({ query } as never);
    const up = query.mock.calls.map(([sql]) => String(sql));
    query.mockClear();
    await migration.down({ query } as never);
    const down = query.mock.calls.map(([sql]) => String(sql));

    expect(migration.transaction).toBe(false);
    expect(up).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_ledger_settlement_id" ON "financial_ledger_entries" ("settlement_id") WHERE "settlement_id" IS NOT NULL',
    ]);
    expect(down).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_ledger_settlement_id"']);
  });
});
