import {
  formatFinancialPreflightReport,
  runFinancialPreflight,
  type SqlQueryable,
} from './financial-preflight';

describe('financial payout preflight', () => {
  it('is read-only, reports blocking violations, and supplies non-destructive remediation', async () => {
    const db: SqlQueryable = {
      query: jest.fn().mockImplementation(async (sql: string) =>
        sql.includes('lower(btrim(transfer_reference))')
          ? [{ transfer_reference: 'bank-1', settlement_ids: ['a', 'b'] }]
          : [],
      ),
    };
    const report = await runFinancialPreflight(db);
    expect(report.valid).toBe(false);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: 'duplicate_normalized_transfer_reference' }),
    ]);
    expect(formatFinancialPreflightReport(report)).toContain('No schema modification was applied');
    expect(formatFinancialPreflightReport(report)).toContain('Quarantine');
    expect(db.query).toHaveBeenCalledTimes(7);
  });

  it('passes clean data without attempting a repair', async () => {
    const db: SqlQueryable = { query: jest.fn().mockResolvedValue([]) };
    await expect(runFinancialPreflight(db)).resolves.toMatchObject({ valid: true, findings: [] });
  });
});
