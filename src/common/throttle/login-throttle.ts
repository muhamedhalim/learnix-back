/**
 * Login rate-limit resolution.
 *
 * BACKGROUND
 * ----------
 * `POST /auth/login` was temporarily moved off `THROTTLE.AUTH` (5 attempts per
 * 5 minutes) onto a 150-per-minute tier so an automated QA suite could exercise
 * many login scenarios from a single IP. The constant carried an explicit
 * instruction to undo it:
 *
 *   "TEMPORARY: TestSprite exercises many login scenarios from one IP. Restore
 *    `THROTTLE.AUTH` on AuthController.login before the next production deploy."
 *
 * That deploy happened. The relaxed tier is live in production today, which
 * means brute-force protection on real accounts is effectively 30x weaker than
 * intended.
 *
 * WHY THIS IS A RESOLVER RATHER THAN A DELETION
 * ---------------------------------------------
 * Simply deleting the tier would restore production safety and immediately
 * re-break the thing it was added for. The underlying need — running an
 * automated login suite against a DEPLOYED environment — is legitimate, and
 * staging exists precisely so that work has somewhere to happen.
 *
 * So the limit becomes a function of deployment identity:
 *
 *   - Production: ALWAYS `THROTTLE.AUTH`. No environment variable can raise it.
 *     This is not a default that can be overridden; the override branch is not
 *     reachable when `APP_ENV` resolves to production.
 *   - Staging / development / test: `LOGIN_THROTTLE_LIMIT` and
 *     `LOGIN_THROTTLE_TTL_MS` may raise it, bounded by `MAX_RELAXED_LIMIT` so a
 *     typo cannot disable rate limiting altogether.
 *
 * The result is strictly safer than both the original and the temporary state:
 * production is back to 5-per-5-minutes and can no longer be relaxed by
 * configuration, while QA keeps a supported path on staging.
 *
 * WHY `process.env` AND NOT `ConfigService`
 * -----------------------------------------
 * `@Throttle()` is a decorator: its argument is evaluated when the controller
 * class is defined, before Nest's DI container exists. `ConfigService` is not
 * available at that moment. This is the same constraint, and the same
 * resolution, as `queues.constants.ts#areQueuesEnabled`.
 */

import { resolveAppEnv } from '../../config/app-env';
import { AppEnvironment } from '../../config/app-env';
import { processEnvReader } from '../utils/redis-connection.util';
import { THROTTLE } from '../constants';

export interface ThrottleTier {
  ttl: number;
  limit: number;
}

/**
 * Ceiling for a relaxed non-production login limit. Chosen to comfortably
 * accommodate an automated suite while still refusing an unbounded value: a
 * mistyped `LOGIN_THROTTLE_LIMIT=100000` clamps here rather than silently
 * turning the limiter off.
 */
const MAX_RELAXED_LIMIT = 200;

/** Shortest window a relaxed configuration may specify. */
const MIN_RELAXED_TTL_MS = 1_000;

function positiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolves the login throttle tier for this process.
 *
 * @param get environment reader; defaults to `process.env`.
 */
export function resolveLoginThrottle(get = processEnvReader()): ThrottleTier {
  // A malformed APP_ENV must never be able to weaken the login limit, so an
  // unreadable identity is treated as production (the strictest branch) rather
  // than being allowed to propagate as an override-eligible environment.
  let appEnv: AppEnvironment;
  try {
    appEnv = resolveAppEnv(get);
  } catch {
    return THROTTLE.AUTH;
  }

  if (appEnv === AppEnvironment.Production) {
    return THROTTLE.AUTH;
  }

  const limit = positiveInteger(get('LOGIN_THROTTLE_LIMIT'));
  const ttl = positiveInteger(get('LOGIN_THROTTLE_TTL_MS'));

  if (limit === undefined && ttl === undefined) {
    return THROTTLE.AUTH;
  }

  return {
    limit: Math.min(limit ?? THROTTLE.AUTH.limit, MAX_RELAXED_LIMIT),
    ttl: Math.max(ttl ?? THROTTLE.AUTH.ttl, MIN_RELAXED_TTL_MS),
  };
}

/**
 * The tier applied to `POST /auth/login`. Evaluated once, at module load, for
 * the reason documented in this file's header.
 */
export const LOGIN_THROTTLE: ThrottleTier = resolveLoginThrottle();
