import { AddDiscountUsagePaymentIndex2111000000000 } from './2111000000000-AddDiscountUsagePaymentIndex';

describe('AddDiscountUsagePaymentIndex2111000000000', () => {
  it('creates and drops exactly the payment_id index, concurrently, outside a transaction', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddDiscountUsagePaymentIndex2111000000000();

    await migration.up({ query } as never);
    const up = query.mock.calls.map(([sql]) => String(sql));
    query.mockClear();
    await migration.down({ query } as never);
    const down = query.mock.calls.map(([sql]) => String(sql));

    expect(migration.transaction).toBe(false);
    expect(up).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_discount_usage_payment" ON "discount_code_usage" ("payment_id")',
    ]);
    expect(down).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_discount_usage_payment"']);
  });
});
