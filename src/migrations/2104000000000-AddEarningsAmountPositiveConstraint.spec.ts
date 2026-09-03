import { AddEarningsAmountPositiveConstraint2104000000000 } from './2104000000000-AddEarningsAmountPositiveConstraint';

describe('AddEarningsAmountPositiveConstraint migration', () => {
  it('adds a CHECK constraint requiring a strictly positive gross amount', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddEarningsAmountPositiveConstraint2104000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ADD CONSTRAINT "CHK_mp_earnings_amount_positive" CHECK ("gross_amount_minor" > 0)');
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE/);
  });

  it('down() drops only the new constraint', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddEarningsAmountPositiveConstraint2104000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_mp_earnings_amount_positive"');
  });
});
