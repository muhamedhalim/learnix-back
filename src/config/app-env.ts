/**
 * `APP_ENV` — the deployment-identity dimension, added alongside `NODE_ENV`
 * rather than replacing it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `NODE_ENV` in this codebase is not a label; it is a *behaviour switch*. It
 * decides whether Redis is mandatory (`app.module.ts`), whether BullMQ may
 * start (`queues.module.ts`), whether `TYPEORM_SYNCHRONIZE=true` is refused,
 * whether object storage is mandatory and `R2_PUBLIC_BASE_URL` is rejected
 * (`storage.service.ts`), whether CSP is applied and Swagger suppressed
 * (`main.ts`), whether stack traces (`http-exception.filter.ts`) and
 * password-reset tokens (`auth.service.ts`) are withheld from responses,
 * whether cookies get `Secure`/`SameSite=None`/`Partitioned`
 * (`cookie-security.util.ts`).
 *
 * A staging deployment needs every one of those protections. So staging runs
 * `NODE_ENV=production` — which leaves it indistinguishable from production in
 * logs, Sentry tags, and health payloads, and leaves nothing to hang
 * cross-environment safety checks on. `APP_ENV` supplies that missing identity
 * without touching a single `NODE_ENV` code path.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * `APP_ENV` is optional. When unset it is *derived* from `NODE_ENV`, so the
 * currently-deployed production service keeps behaving exactly as it does
 * today with no variable added. Setting it explicitly is strongly recommended
 * (and required when `APP_ENV_STRICT=true`), but never retrofitted as a
 * breaking requirement.
 *
 * This mirrors the reasoning already applied in `common/utils/database-ssl.util.ts`,
 * which derives SSL from the connection target rather than `NODE_ENV` because
 * `NODE_ENV`-gating breaks in both directions.
 */

import type { EnvReader } from '../common/utils/redis-connection.util';

export enum AppEnvironment {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

export const APP_ENVIRONMENTS: readonly string[] = Object.freeze(
  Object.values(AppEnvironment) as string[],
);

/** Raised by `resolveAppEnv` when `APP_ENV` is present but not a supported value. */
export class UnsupportedAppEnvError extends Error {
  public constructor(received: string) {
    super(
      `APP_ENV must be one of: ${APP_ENVIRONMENTS.join(', ')}. Received: "${received}". ` +
        'Leave APP_ENV unset to derive it from NODE_ENV.',
    );
    this.name = 'UnsupportedAppEnvError';
  }
}

/** Raised when `APP_ENV_STRICT=true` but `APP_ENV` was not supplied. */
export class MissingAppEnvError extends Error {
  public constructor() {
    super(
      'APP_ENV is required when APP_ENV_STRICT=true. ' +
        `Set APP_ENV to one of: ${APP_ENVIRONMENTS.join(', ')}.`,
    );
    this.name = 'MissingAppEnvError';
  }
}

/**
 * Derivation used when `APP_ENV` is absent. Deliberately conservative: an
 * unrecognised `NODE_ENV` yields `development`, never `production`, so a typo
 * can only ever *reduce* the assumed trust level of the deployment identity.
 * (It cannot reduce the real protections, which remain keyed on `NODE_ENV`.)
 */
function deriveFromNodeEnv(nodeEnv: string | undefined): AppEnvironment {
  switch (nodeEnv) {
    case 'production': {
      return AppEnvironment.Production;
    }
    case 'test': {
      return AppEnvironment.Test;
    }
    default: {
      return AppEnvironment.Development;
    }
  }
}

/**
 * Resolves the effective application environment.
 *
 * @throws {UnsupportedAppEnvError} when `APP_ENV` holds an unrecognised value.
 * @throws {MissingAppEnvError} when `APP_ENV_STRICT=true` and `APP_ENV` is absent.
 */
export function resolveAppEnv(get: EnvReader): AppEnvironment {
  const raw = get('APP_ENV');
  const strict = get('APP_ENV_STRICT') === 'true';

  if (raw === undefined || raw.trim() === '') {
    if (strict) throw new MissingAppEnvError();
    return deriveFromNodeEnv(get('NODE_ENV'));
  }

  const normalized = raw.trim().toLowerCase();
  if (!APP_ENVIRONMENTS.includes(normalized)) {
    throw new UnsupportedAppEnvError(raw);
  }

  return normalized as AppEnvironment;
}

/** `(key) => config[key]` adapter for the plain object `validate()` receives. */
export function recordReader(config: Record<string, unknown>): EnvReader {
  return (key) => {
    const value = config[key];
    return typeof value === 'string' ? value : undefined;
  };
}

export function isStaging(appEnv: AppEnvironment): boolean {
  return appEnv === AppEnvironment.Staging;
}

export function isProductionEnv(appEnv: AppEnvironment): boolean {
  return appEnv === AppEnvironment.Production;
}

/**
 * True for deployments that face real or prospective users (production and
 * staging), as opposed to a developer machine or a test runner. Used to decide
 * where the isolation rules apply at all.
 */
export function isDeployedEnv(appEnv: AppEnvironment): boolean {
  return appEnv === AppEnvironment.Production || appEnv === AppEnvironment.Staging;
}

/**
 * Resolves `APP_ENV` to a plain string for use in LABELS: Sentry tags, log
 * fields, health-payload `environment` values, error-fingerprint components.
 *
 * Deliberately never throws. These call sites run on every request/error/health
 * check across the app's lifetime, including from contexts that predate or
 * bypass `ConfigModule`'s `validate()` (unit tests constructing a service
 * directly with a bare `ConfigService` stub, for instance) — a malformed
 * `APP_ENV` reaching a logging call must degrade to a label, never crash the
 * thing trying to report the problem. `validate()` is still what guarantees a
 * REAL boot never has an invalid `APP_ENV` in the first place; this is the
 * defensive fallback for every other caller.
 */
export function resolveAppEnvLabel(get: EnvReader): string {
  try {
    return resolveAppEnv(get);
  } catch {
    return get('NODE_ENV') ?? 'development';
  }
}
