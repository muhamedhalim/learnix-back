/**
 * Professional Courses Marketplace configuration (T003).
 *
 * Every value here is a **launch default** from spec.md §Y's Configuration
 * Register, administrator-configurable under FR-332 without a deploy: set
 * the named environment variable to override it. No marketplace service
 * reads `process.env` directly for one of these — everything goes through
 * `getMarketplaceConfig()`, so there is exactly one place each default lives.
 *
 * Values are parsed once per call (not cached at module load) so tests can
 * mutate `process.env` and observe the change, matching the pattern already
 * used by `CommissionService` and `feature-flags.ts`.
 */

/**
 * Whether `MarketplaceModule` is registered at all (T002, FR-005).
 *
 * Unlike the scheduled-work flags in `feature-flags.ts` (default-on,
 * explicit-off — they gate jobs already live in production), this defaults
 * OFF: the feature is still being built out phase by phase, and importing a
 * partially-complete module by default would be the unsafe direction. Once
 * the feature reaches launch readiness, production sets
 * `MARKETPLACE_ENABLED=true` as a deliberate, unambiguous act — the mirror
 * image of how the existing flags are deliberately disabled.
 *
 * Read from `process.env` directly (not `ConfigService`) because this is
 * consulted from `AppModule`'s static `imports` array, evaluated before
 * Nest's DI container exists — the same constraint `areQueuesEnabled()` and
 * `areBackgroundJobsEnabled()` document.
 */
export function isMarketplaceEnabled(): boolean {
  return process.env['MARKETPLACE_ENABLED'] === 'true';
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface MarketplaceConfig {
  /** FR-131 — 3000 bps (30.00%) at launch. */
  commissionRateBps: number;
  /** FR-177, FR-179 — the refund window is inclusive of its final instant. */
  refundWindowDays: number;
  /** FR-178, FR-179 — the consumption cap is exclusive; 3000 = 30.00%. */
  refundConsumptionCapBps: number;
  /** FR-055 — minimum lessons for publication readiness. */
  minLessonsForPublication: number;
  /** FR-055, FR-333 — minimum required lessons for publication readiness. */
  minRequiredLessonsForPublication: number;
  /** FR-049 — proportion of lessons that may be free previews. */
  freePreviewProportion: number;
  /** FR-049 — the hard cap on free-preview lessons regardless of proportion. */
  freePreviewMaxCount: number;
  /** FR-016 — days a rejected applicant must wait before resubmitting. */
  applicationResubmissionWaitDays: number;
  /** FR-016 — maximum applications before administrative re-enablement is required. */
  applicationMaxAttempts: number;
  /** FR-303 — signed-URL lifetime in seconds, at most 900. */
  signedUrlTtlSeconds: number;
  /** FR-330 — public anonymous catalogue cache lifetime in seconds. */
  publicCacheTtlSeconds: number;
  /** FR-077, FR-281 — default list page size. */
  defaultPageSize: number;
  /** FR-077, FR-281 — maximum list page size. */
  maxPageSize: number;
  /** FR-308 — requests per minute for the strict tier (application, refund, payout). */
  strictRateLimitPerMinute: number;
  /** FR-121 — free-enrollment requests per minute. */
  freeEnrollmentRateLimitPerMinute: number;
  /** FR-121 — free-enrollment successes per rolling 24 hours. */
  freeEnrollmentRateLimitPerDay: number;
  /** FR-315 — instructor application retention, in months. */
  applicationRetentionMonths: number;
  /** FR-316 — financial and certificate record retention, in years. */
  financialRetentionYears: number;
}

export function getMarketplaceConfig(): MarketplaceConfig {
  return {
    commissionRateBps: int('MARKETPLACE_COMMISSION_RATE_BPS', 3000),
    refundWindowDays: int('MARKETPLACE_REFUND_WINDOW_DAYS', 14),
    refundConsumptionCapBps: int('MARKETPLACE_REFUND_CONSUMPTION_CAP_BPS', 3000),
    minLessonsForPublication: int('MARKETPLACE_MIN_LESSONS_FOR_PUBLICATION', 3),
    minRequiredLessonsForPublication: int('MARKETPLACE_MIN_REQUIRED_LESSONS_FOR_PUBLICATION', 1),
    freePreviewProportion: Number.parseFloat(process.env['MARKETPLACE_FREE_PREVIEW_PROPORTION'] ?? '0.20'),
    freePreviewMaxCount: int('MARKETPLACE_FREE_PREVIEW_MAX_COUNT', 5),
    applicationResubmissionWaitDays: int('MARKETPLACE_APPLICATION_RESUBMISSION_WAIT_DAYS', 14),
    applicationMaxAttempts: int('MARKETPLACE_APPLICATION_MAX_ATTEMPTS', 3),
    signedUrlTtlSeconds: int('MARKETPLACE_SIGNED_URL_TTL_SECONDS', 900),
    publicCacheTtlSeconds: int('MARKETPLACE_PUBLIC_CACHE_TTL_SECONDS', 60),
    defaultPageSize: int('MARKETPLACE_DEFAULT_PAGE_SIZE', 20),
    maxPageSize: int('MARKETPLACE_MAX_PAGE_SIZE', 100),
    strictRateLimitPerMinute: int('MARKETPLACE_STRICT_RATE_LIMIT_PER_MINUTE', 3),
    freeEnrollmentRateLimitPerMinute: int('MARKETPLACE_FREE_ENROLLMENT_RATE_LIMIT_PER_MINUTE', 5),
    freeEnrollmentRateLimitPerDay: int('MARKETPLACE_FREE_ENROLLMENT_RATE_LIMIT_PER_DAY', 10),
    applicationRetentionMonths: int('MARKETPLACE_APPLICATION_RETENTION_MONTHS', 24),
    financialRetentionYears: int('MARKETPLACE_FINANCIAL_RETENTION_YEARS', 10),
  };
}

/** FR-319 alert thresholds. Owner is informational — routing is a later (T220) concern. */
export const MARKETPLACE_ALERT_THRESHOLDS = {
  FAILED_PURCHASE: { count: 5, windowMinutes: 15, owner: 'platform-engineering' },
  STALLED_PAYMENT_CONFIRMATION: { minutes: 30, owner: 'platform-engineering' },
  FAILED_MEDIA_UPLOAD: { count: 10, windowMinutes: 15, owner: 'platform-engineering' },
  STUCK_REVIEW_QUEUE: { hours: 72, owner: 'marketplace-operations' },
  STALLED_CLEARANCE: { staleHours: 26, owner: 'finance-operations' },
  STUCK_PAYOUT: { days: 7, owner: 'finance-operations' },
  FAILED_REFUND: { immediate: true, owner: 'finance-operations' },
  LEDGER_DIVERGENCE: { immediate: true, owner: 'finance-operations' },
} as const;
