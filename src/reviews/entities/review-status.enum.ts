/**
 * Moderation state of a review.
 *
 * Reviews default to APPROVED so the existing "appears immediately" behaviour is
 * preserved (spam is handled by validation + rate limiting, not a pre-approval
 * queue). Admins can move a review to REJECTED (spam/abuse, hidden) or FLAGGED
 * (under review, hidden from the public but retained for moderator inspection).
 * Only APPROVED reviews are surfaced on public endpoints and in aggregates.
 */
export enum ReviewStatus {
  APPROVED = 'approved',
  FLAGGED = 'flagged',
  REJECTED = 'rejected',
}
