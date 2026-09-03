import { FINANCE_PERMISSIONS } from './finance-permissions';

/**
 * T005: appending the nine `marketplace.*` permissions must be additive
 * only — every permission string that existed before this feature must
 * still exist, unchanged, afterwards (FR-306).
 */
describe('FINANCE_PERMISSIONS additivity', () => {
  const PRE_MARKETPLACE_PERMISSIONS = [
    'refunds.create',
    'refunds.process',
    'refunds.complete',
    'manual_payments.review',
    'manual_payments.approve',
    'manual_payments.manage_methods',
    'settlements.create',
    'settlements.view',
    'settlements.approve',
    'settlements.pay',
    'settlements.reject',
    'settlements.cancel',
    'reports.view',
    'reports.export',
    'reconciliation.run',
    'reconciliation.review',
  ] as const;

  it('keeps every pre-existing permission string exactly as it was', () => {
    for (const permission of PRE_MARKETPLACE_PERMISSIONS) {
      expect(FINANCE_PERMISSIONS).toContain(permission);
    }
  });

  it('adds exactly the nine marketplace.* permissions from contracts/README.md §7', () => {
    const marketplacePermissions = FINANCE_PERMISSIONS.filter((p) => p.startsWith('marketplace.'));
    expect(marketplacePermissions.sort()).toEqual(
      [
        'marketplace.reports.view',
        'marketplace.reports.export',
        'marketplace.refunds.view',
        'marketplace.refunds.process',
        'marketplace.payouts.view',
        'marketplace.payouts.approve',
        'marketplace.payouts.pay',
        'marketplace.commission.manage',
        'marketplace.ledger.adjust',
      ].sort(),
    );
  });

  it('has no duplicate permission strings', () => {
    expect(new Set(FINANCE_PERMISSIONS).size).toBe(FINANCE_PERMISSIONS.length);
  });
});
