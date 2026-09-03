/** The capability record's own lifecycle. `users.role` is never read or written (Q2, FR-009). */
export enum MarketplaceInstructorStatus {
  APPROVED = 'approved',
  SUSPENDED = 'suspended',
  WITHDRAWN = 'withdrawn',
}
