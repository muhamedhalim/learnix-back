export const FINANCE_PERMISSIONS = [
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  // AUD-032: manual-payment administration is its own capability. It used to
  // borrow `refunds.complete`, which forced a two-way privilege violation —
  // a clerk who should only vet bank transfers had to be handed the power to
  // finalise refunds, and anyone entitled to finalise refunds could silently
  // approve payments (i.e. grant paid access) as a side effect.
  //
  // Split along the same create/execute lines the refund and settlement
  // permissions already use:
  //   review         — work the queue: start review, ask the student for more
  //                    information, reject, cancel. Moves no money.
  //   approve        — the privileged one: runs the shared finalisation, so it
  //                    grants entitlement and posts to the ledger.
  //   manage_methods — configure which manual channels exist and their
  //                    instructions/limits. Configuration, not a transaction.
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
  // Professional Courses Marketplace (spec.md §V, contracts/README.md §7).
  // Additive only — no existing permission string above is altered.
  'marketplace.reports.view',
  'marketplace.reports.export',
  'marketplace.refunds.view',
  'marketplace.refunds.process',
  'marketplace.payouts.view',
  'marketplace.payouts.approve',
  'marketplace.payouts.pay',
  'marketplace.commission.manage',
  'marketplace.ledger.adjust',
] as const;

export type FinancePermission = (typeof FINANCE_PERMISSIONS)[number];
