/**
 * Scheduled-work feature flags.
 *
 * WHY THESE EXIST
 * ---------------
 * This application runs eleven `@Cron` jobs inside the API process (see
 * `docs/CRON_AUDIT.md`). Three of them mutate financial state — payment
 * reconciliation, gateway-webhook replay, and settlement maintenance — and two
 * of them DELETE storage objects. None was gated by anything: they arm at boot
 * and the first fires sixty seconds later.
 *
 * That is acceptable for production, where those jobs are the intended
 * behaviour. It is not acceptable as the *only* possible behaviour, because it
 * leaves no way to stand up a second environment, or to stop a
 * reconciliation loop during an incident, without redeploying modified code.
 *
 * DEFAULT-ON, EXPLICIT-OFF
 * ------------------------
 * Every flag defaults to ENABLED. A flag is disabled only by setting it to the
 * exact string `false`. This is deliberate and load-bearing: production sets
 * none of these variables today, so every job keeps running exactly as it does
 * now. There is no configuration in which adding this module changes existing
 * behaviour — an absent variable, an empty string, a typo, or `FALSE` in the
 * wrong case all resolve to enabled.
 *
 * Turning off a financial job must be a deliberate, unambiguous act.
 *
 * WHY `process.env` AND NOT `ConfigService`
 * -----------------------------------------
 * `areBackgroundJobsEnabled()` is consulted from static `@Module()` metadata,
 * evaluated before Nest's DI container exists — the same constraint documented
 * in `queues.constants.ts`. The remaining flags are read through
 * `isFeatureEnabled` at call time and accept an injected reader so they are
 * trivially testable.
 */

import type { EnvReader } from '../common/utils/redis-connection.util';
import { processEnvReader } from '../common/utils/redis-connection.util';

export const FEATURE_FLAGS = {
  /**
   * Per-minute payment reconciliation and the 30-minute settlement sweep
   * (`payments/services/payment-operations.service.ts`).
   *
   * FINANCIAL. Disabling it stops payments from being reconciled and teacher
   * earnings from becoming settlement-eligible. Never disable on production
   * except during a declared incident.
   */
  PAYMENT_RECONCILIATION: 'ENABLE_PAYMENT_RECONCILIATION',

  /**
   * Per-minute recovery of stale/failed gateway webhook events
   * (`payments/services/gateway-webhook.service.ts`).
   *
   * FINANCIAL. Disabling it means a webhook the provider already considers
   * delivered is never retried, so a captured payment can stay unapplied.
   */
  WEBHOOK_REPLAY: 'ENABLE_WEBHOOK_REPLAY',

  /**
   * Weekly orphan-file cleanup (`uploads/cleanup.service.ts`) and the
   * 30-minute expired-upload saga (`lessons/lessons.service.ts`).
   *
   * DESTRUCTIVE. These delete objects from the configured storage bucket and
   * videos from the configured Bunny library. This is the flag to reach for
   * when an environment's storage credentials are not yet confirmed isolated.
   */
  FILE_CLEANUP: 'ENABLE_FILE_CLEANUP',

  /**
   * Outbound guardian notification delivery
   * (`notifications/processors/parent-notification.processor.ts`).
   *
   * CONTACTS REAL PEOPLE. Disabling it parks messages rather than sending
   * them. Complements — and does not replace — `MAIL_ALLOWLIST` and
   * `SMS_MODE=sandbox`, which constrain *who* can be reached; this constrains
   * *whether* delivery is attempted at all.
   */
  NOTIFICATIONS: 'ENABLE_NOTIFICATIONS',

  /**
   * Master switch for BullMQ queue processing. When disabled, queues resolve
   * to `NoopQueue` and no worker consumes jobs, exactly as when Redis is
   * unconfigured in development.
   */
  BACKGROUND_JOBS: 'ENABLE_BACKGROUND_JOBS',
} as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

/**
 * True unless the variable is exactly `false`.
 *
 * The comparison is intentionally strict rather than truthiness-based: a job
 * that moves money should not be disabled by an empty string, a stray `0`, or
 * a mis-cased `FALSE`.
 */
export function isFeatureEnabled(flag: FeatureFlag, get: EnvReader = processEnvReader()): boolean {
  return get(flag) !== 'false';
}

/**
 * Whether BullMQ workers should process jobs. Consulted from static module
 * metadata, so it reads `process.env` directly.
 */
export function areBackgroundJobsEnabled(get: EnvReader = processEnvReader()): boolean {
  return isFeatureEnabled(FEATURE_FLAGS.BACKGROUND_JOBS, get);
}

/**
 * Renders the current flag state for a startup log line. Contains no secrets —
 * flag names and booleans only.
 */
export function describeFeatureFlags(get: EnvReader = processEnvReader()): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const flag of Object.values(FEATURE_FLAGS)) {
    state[flag] = isFeatureEnabled(flag, get);
  }
  return state;
}
