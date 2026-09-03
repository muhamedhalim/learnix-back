/**
 * FR-106. Deliberately no `EXPIRED` value: marketplace access is perpetual
 * unless suspended or revoked, so an expiring state would be unreachable.
 */
export enum MarketplaceEnrollmentStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  REVOKED = 'revoked',
}
