/**
 * Release / build identity for monitoring.
 *
 * One resolution order, used by every monitoring surface (Sentry `release`,
 * structured logs, the `/metrics` build-info gauge, and the health dashboard's
 * `backendVersion`), so an incident can be tied to a specific deployment
 * regardless of which surface surfaced it.
 *
 * Deliberately reads the platform-injected commit SHA as a fallback:
 * `RAILWAY_GIT_COMMIT_SHA` is set automatically by Railway on every deploy, so
 * a correctly-tagged release requires no dashboard change at all. An explicit
 * `SENTRY_RELEASE`/`APP_VERSION` still wins when an operator sets one.
 *
 * The frontend derives its release the same way from `VERCEL_GIT_COMMIT_SHA`
 * (see `dodline/next.config.ts`), so a backend and frontend deployed from the
 * same commit report the SAME release string and can be correlated in Sentry.
 */

import type { EnvReader } from '../common/utils/redis-connection.util';

/** Platform-injected commit SHA variables, in precedence order. */
const COMMIT_SHA_KEYS = [
  'RAILWAY_GIT_COMMIT_SHA',
  'GIT_COMMIT',
  'RENDER_GIT_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'GITHUB_SHA',
] as const;

function firstNonEmpty(get: EnvReader, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = get(key);
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * The release identifier attached to monitoring events, or `undefined` when
 * nothing identifies this build. Never invents a value: an unset release is
 * more honest than a fabricated one, and Sentry treats "no release" correctly.
 */
export function resolveRelease(get: EnvReader): string | undefined {
  return firstNonEmpty(get, ['SENTRY_RELEASE', 'APP_VERSION', ...COMMIT_SHA_KEYS]);
}

/**
 * The commit SHA alone, when the platform exposes one. Reported separately from
 * `release` so a human-readable `APP_VERSION` release (e.g. `1.4.2`) does not
 * hide which commit actually shipped.
 */
export function resolveCommitSha(get: EnvReader): string | undefined {
  return firstNonEmpty(get, COMMIT_SHA_KEYS);
}

/**
 * Display version for the health dashboard. Falls back to the historical
 * `'0.0.1'` literal so the dashboard contract is unchanged when nothing is set.
 */
export function resolveServiceVersion(get: EnvReader): string {
  return (
    firstNonEmpty(get, ['APP_VERSION', 'npm_package_version']) ?? resolveRelease(get) ?? '0.0.1'
  );
}
