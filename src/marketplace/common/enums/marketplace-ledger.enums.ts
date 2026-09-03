/**
 * Marketplace's own ledger vocabulary (research D2 — separate from
 * `financial_ledger_entries` / `LedgerEntryType` in `payments/entities/ledger.enums.ts`).
 */

/** FR-159. */
export enum MarketplaceLedgerEntryType {
  COURSE_SALE = 'course_sale',
  PLATFORM_COMMISSION = 'platform_commission',
  REFUND = 'refund',
  REFUND_COMMISSION_REVERSAL = 'refund_commission_reversal',
  PAYOUT = 'payout',
  PAYOUT_REVERSAL = 'payout_reversal',
  MANUAL_ADJUSTMENT = 'manual_adjustment',
  /** FR-195, FR-196 (T139) — a refund reversing an earning already `paid_out`; recorded in full, carried forward against future earnings rather than reducing anything retroactively. */
  REFUND_SHORTFALL = 'refund_shortfall',
}

/** FR-161 — explicit, never inferred from the sign of `amount_minor`. */
export enum MarketplaceLedgerDirection {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

/** Mirrors the existing `LedgerEntryStatus` vocabulary for the marketplace's own entries. */
export enum MarketplaceLedgerEntryStatus {
  POSTED = 'posted',
  REVERSED = 'reversed',
}
