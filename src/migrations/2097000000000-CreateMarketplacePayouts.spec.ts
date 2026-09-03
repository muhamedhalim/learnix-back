import { CreateMarketplacePayouts2097000000000 } from './2097000000000-CreateMarketplacePayouts';

describe('CreateMarketplacePayouts migration', () => {
  it('creates payout accounts and requests with the one-default-per-currency and paid-reference constraints', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplacePayouts2097000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('"marketplace_payout_accounts"');
    expect(sql).toContain('"marketplace_payout_requests"');
    expect(sql).toContain('UQ_mp_payout_accounts_default');
    expect(sql).toContain('CHK_mp_payouts_paid_reference');
    expect(sql).toContain('CHK_mp_payouts_reject_reason');
    expect(sql).toContain('UQ_mp_payout_requests_idempotency');
    expect(sql).toContain('FK_mp_earnings_payout_request');
    expect(sql).toContain('FK_mp_ledger_payout_request');
  });

  it('down() drops the deferred foreign keys before the payout tables', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplacePayouts2097000000000().down({ query } as never);

    const calls = query.mock.calls.map(([statement]) => String(statement));
    expect(calls[0]).toContain('DROP CONSTRAINT IF EXISTS "FK_mp_ledger_payout_request"');
    expect(calls[1]).toContain('DROP TABLE IF EXISTS "marketplace_payout_requests"');
    expect(calls[2]).toContain('DROP TABLE IF EXISTS "marketplace_payout_accounts"');
  });
});
