/** Order state machine, plan.md §6. Zero-value orders are created directly in `PAID` (FR-112). */
export enum MarketplaceOrderStatus {
  AWAITING_PAYMENT = 'awaiting_payment',
  PAID = 'paid',
  FAILED = 'failed',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}
