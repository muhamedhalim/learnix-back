/**
 * Lifecycle state of an individual attendance code.
 *
 * - UNUSED    → generated, not yet redeemed, still active and not expired.
 * - REDEEMED  → consumed by a student to gain access (terminal).
 * - EXPIRED   → passed its `expires_at` without being redeemed.
 * - REVOKED   → manually disabled/cancelled by an admin (terminal).
 *
 * `is_used` / `is_active` are retained on the entity for backward compatibility
 * with existing verify/redeem logic; `status` is the canonical lifecycle field.
 */
export enum AttendanceCodeStatus {
  GENERATED = 'generated',
  ASSIGNED = 'assigned',
  ACTIVE = 'active',
  RESERVED = 'reserved',
  UNUSED = 'unused',
  REDEEMED = 'redeemed',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}
