export const FINANCE_PERMISSIONS = [
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  'settlements.create',
  'settlements.approve',
  'settlements.pay',
  'reconciliation.run',
  'reconciliation.review',
] as const;

export type FinancePermission = (typeof FINANCE_PERMISSIONS)[number];
