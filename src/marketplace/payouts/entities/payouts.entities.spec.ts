import { getMetadataArgsStorage } from 'typeorm';

import { MarketplacePayoutAccount } from './marketplace-payout-account.entity';
import { MarketplacePayoutRequest } from './marketplace-payout-request.entity';

describe('MarketplacePayoutAccount entity', () => {
  it('carries the encrypted identifier and only exposes a last-4 mask column (FR-203)', () => {
    const names = getMetadataArgsStorage()
      .columns.filter((c) => c.target === MarketplacePayoutAccount)
      .map((c) => c.propertyName);
    expect(names).toEqual(
      expect.arrayContaining(['account_identifier_encrypted', 'account_identifier_last4']),
    );
  });

  it('allows exactly one default account per (instructor, currency) (FR-202)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplacePayoutAccount && i.name === 'UQ_mp_payout_accounts_default',
    );
    expect(index?.unique).toBe(true);
    expect(index?.where).toContain('is_default');
  });
});

describe('MarketplacePayoutRequest entity', () => {
  it('requires a payout reference before it can be marked paid (FR-219)', () => {
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === MarketplacePayoutRequest && c.name === 'CHK_mp_payouts_paid_reference',
    );
    expect(check).toBeDefined();
  });

  it('carries a unique idempotency key', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplacePayoutRequest && i.name === 'UQ_mp_payout_requests_idempotency',
    );
    expect(index?.unique).toBe(true);
  });
});
