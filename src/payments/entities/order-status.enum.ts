export enum OrderStatus {
  AWAITING_PAYMENT = 'awaiting_payment',
  PAYMENT_SUBMITTED = 'payment_submitted',
  UNDER_REVIEW = 'under_review',
  PAID = 'paid',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  PARTIALLY_REFUNDED = 'partially_refunded',
  REFUNDED = 'refunded',
}
