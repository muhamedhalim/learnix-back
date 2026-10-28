import { GrantAdminMarketplaceFinancePermissions2211000000000 } from './2211000000000-GrantAdminMarketplaceFinancePermissions';

describe('GrantAdminMarketplaceFinancePermissions migration', () => {
  it('adds the nine marketplace permissions to administrators only, keeping what they already hold', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new GrantAdminMarketplaceFinancePermissions2211000000000().up({ query } as never);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain(`WHERE "role" = 'admin'`);
    for (const permission of [
      'marketplace.reports.view',
      'marketplace.reports.export',
      'marketplace.refunds.view',
      'marketplace.refunds.process',
      'marketplace.payouts.view',
      'marketplace.payouts.approve',
      'marketplace.payouts.pay',
      'marketplace.commission.manage',
      'marketplace.ledger.adjust',
    ]) {
      expect(sql).toContain(permission);
    }
    // A union with the current value, not an overwrite.
    expect(sql).toContain('"users"."finance_permissions" ||');
    // Idempotent: skips administrators who already hold all of them.
    expect(sql).toContain('NOT ("finance_permissions" @>');
  });

  it('never removes a permission on the way down', async () => {
    await expect(
      new GrantAdminMarketplaceFinancePermissions2211000000000().down(),
    ).resolves.toBeUndefined();
  });
});
