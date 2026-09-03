import { CreateMarketplaceMoney2096000000000 } from './2096000000000-CreateMarketplaceMoney';

describe('CreateMarketplaceMoney migration', () => {
  it('creates the currency registry seeded with exactly the launch EGP row', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceMoney2096000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('"marketplace_currencies"');
    expect(sql).toContain("VALUES ('EGP', 2, true, 5000, 2000000, 50000)");
    expect(sql).toContain('CHK_mp_currencies_bounds');
    expect(sql).toContain('CHK_mp_currencies_exponent');
  });

  it('creates commission settings, earnings, ledger and refund requests with their invariants', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceMoney2096000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('"marketplace_commission_settings"');
    expect(sql).toContain('"marketplace_instructor_earnings"');
    expect(sql).toContain('UQ_mp_earnings_order');
    expect(sql).toContain('"marketplace_ledger_entries"');
    expect(sql).toContain('UQ_mp_ledger_reference');
    expect(sql).toContain('CHK_mp_ledger_adjustment_reason');
    expect(sql).toContain('"marketplace_refund_requests"');
    expect(sql).toContain('UQ_mp_refunds_open_per_order');
  });

  it('attaches the BEFORE UPDATE OR DELETE immutability trigger to the ledger', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceMoney2096000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE TRIGGER "TRG_mp_ledger_immutable"');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "marketplace_ledger_entries"');
    expect(sql).toContain('mp_prevent_ledger_mutation');
  });

  it('down() drops the trigger before the table and every table in dependency order', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceMoney2096000000000().down({ query } as never);

    const calls = query.mock.calls.map(([statement]) => String(statement));
    expect(calls[0]).toContain('DROP TABLE IF EXISTS "marketplace_refund_requests"');
    expect(calls[1]).toContain('DROP TRIGGER IF EXISTS "TRG_mp_ledger_immutable"');
    expect(calls[2]).toContain('DROP TABLE IF EXISTS "marketplace_ledger_entries"');
    expect(calls[3]).toContain('DROP TABLE IF EXISTS "marketplace_instructor_earnings"');
    expect(calls[4]).toContain('DROP TABLE IF EXISTS "marketplace_commission_settings"');
    expect(calls[5]).toContain('DROP TABLE IF EXISTS "marketplace_currencies"');
  });
});
