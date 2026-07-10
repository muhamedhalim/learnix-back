/**
 * Compute when a time-boxed lesson access grant expires, given the moment
 * access was granted and the number of access days purchased.
 *
 * Access is inclusive of the full calendar day the grant happened, plus
 * (accessDays - 1) more full days, expiring at the very start (00:00:00 UTC)
 * of the day immediately after the Nth day — regardless of what time of day
 * the grant happened.
 *
 * Example: granted at any time on 1 Jul with accessDays=7 → available through
 * all of 1 Jul – 7 Jul inclusive, expires at the start of 8 Jul. A purchase at
 * 23:59 gets the same cutoff date as one at 00:01 the same day; without this
 * truncation, `grantedAt + N days` preserves the time-of-day and grants up to
 * one extra (partial) day of access beyond what "N days" should mean.
 *
 * Calendar days are computed in UTC so the boundary is deterministic
 * regardless of the server's local timezone (access_expires_at is timestamptz).
 */
export function computeAccessExpiresAt(grantedAt: Date, accessDays: number): Date {
  const expiresAt = new Date(
    Date.UTC(
      grantedAt.getUTCFullYear(),
      grantedAt.getUTCMonth(),
      grantedAt.getUTCDate(),
    ),
  );
  expiresAt.setUTCDate(expiresAt.getUTCDate() + accessDays);
  return expiresAt;
}
