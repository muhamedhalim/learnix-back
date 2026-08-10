/**
 * Aggregate state for a single cart charge. Product fulfilment continues to
 * live on the child orders so accounting and refunds stay product-scoped.
 */
export enum CartCheckoutStatus {
  AWAITING_PAYMENT = 'awaiting_payment',
  PAYMENT_PROCESSING = 'payment_processing',
  PAID = 'paid',
  FAILED = 'failed',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  RECONCILIATION_REQUIRED = 'reconciliation_required',
}
