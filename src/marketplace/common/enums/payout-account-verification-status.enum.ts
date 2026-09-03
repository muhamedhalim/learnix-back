/** FR-201's "verification state"; values are an implementation minimum, not further specified by spec.md. */
export enum PayoutAccountVerificationStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}
