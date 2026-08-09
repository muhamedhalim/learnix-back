export enum LessonSessionBookingStatus {
  HELD = 'held',
  PAYMENT_REVIEW = 'payment_review',
  CONFIRMED = 'confirmed',
  EXPIRED = 'expired',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

export const ACTIVE_LESSON_SESSION_BOOKING_STATUSES = [
  LessonSessionBookingStatus.HELD,
  LessonSessionBookingStatus.PAYMENT_REVIEW,
  LessonSessionBookingStatus.CONFIRMED,
] as const;
