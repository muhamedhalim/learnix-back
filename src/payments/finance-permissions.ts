export const FINANCE_PERMISSIONS = [
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  'settlements.create',
  'settlements.view',
  'settlements.approve',
  'settlements.pay',
  'settlements.reject',
  'settlements.cancel',
  'reconciliation.run',
  'reconciliation.review',
] as const;

export type FinancePermission = (typeof FINANCE_PERMISSIONS)[number];
