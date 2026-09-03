/**
 * Coarse grouping for admin-facing notifications, shown alongside the
 * priority so an admin can scan the inbox by area of responsibility.
 */
export enum AdminNotificationCategory {
  INSTRUCTOR_APPROVAL = 'instructor_approval',
  CONTENT_REVIEW = 'content_review',
  FINANCIAL = 'financial',
  PAYOUT = 'payout',
  SECURITY = 'security',
  SYSTEM = 'system',
}
