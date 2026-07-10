/**
 * Ownership state of a guardian's phone number.
 *
 * Only `VERIFIED` guardians receive non-transactional notifications — an
 * unverified number may belong to a stranger (or to the student themselves),
 * and we must never send a named child's grades to an unproven handset.
 */
export enum GuardianVerificationStatus {
  /** Captured but never challenged. Cannot receive educational notifications. */
  UNVERIFIED = 'unverified',
  /** An OTP is outstanding. */
  PENDING = 'pending',
  /** Ownership proven via OTP. */
  VERIFIED = 'verified',
}
