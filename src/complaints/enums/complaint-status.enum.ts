export enum ComplaintStatus {
  NEW = 'new',
  /** Retained for complaints created before the Call Center lifecycle. */
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  WAITING_FOR_USER = 'waiting_for_user',
  WAITING_FOR_INTERNAL_REVIEW = 'waiting_for_internal_review',
  ESCALATED = 'escalated',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
  REOPENED = 'reopened',
}
