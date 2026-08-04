/**
 * Lifecycle of a subject in the shared catalogue.
 *
 * Teacher-created subjects start at `PENDING_APPROVAL` and are usable only by
 * their author until an admin approves them. Admin-created subjects (and every
 * row that predates the ownership migration) are `APPROVED` from the start.
 */
export enum SubjectStatus {
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
}
