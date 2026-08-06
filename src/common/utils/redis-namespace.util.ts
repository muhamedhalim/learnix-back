/**
 * Redis key namespacing — Phase 2 (Database and Redis) of
 * STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md.
 *
 * WHY THIS EXISTS
 * ----------------
 * Every Redis consumer in this codebase (cache, BullMQ queues, rate-limit
 * storage, idempotency keys, the distributed single-flight lock, and the
 * health-collector's cross-replica coordination key) writes keys with a
 * fixed, environment-agnostic literal prefix. Isolation between Production
 * and Staging today depends entirely on each pointing at a *different Redis
 * host* — real isolation, but not defence in depth. If a staging deployment
 * is ever pointed at the production Redis host by mistake, nothing at the key
 * level stops it from reading, overwriting, or expiring production's cache
 * entries, rate-limit counters, queue jobs, idempotency records, or
 * cross-replica locks. `REDIS_NAMESPACE` already exists (Phase 0) and is
 * already validated for shape by `environment-isolation.guard.ts`, but until
 * this module nothing applied it to an actual key.
 *
 * WHY PRODUCTION'S DEFAULT IS THE EMPTY STRING
 * ---------------------------------------------
 * Production does not set `REDIS_NAMESPACE` today. If the default namespace
 * for a resolved-production environment were non-empty, every cache, queue,
 * rate-limit, idempotency and lock key would change shape the moment this
 * code deploys — a live behaviour change to the currently-deployed service
 * for a "staging-only" phase of work. So: no explicit `REDIS_NAMESPACE` and a
 * resolved environment of `production` yields an EMPTY namespace, which every
 * function below treats as "add nothing" — byte-identical key shapes to
 * today. Staging and test have no legacy keys to preserve, so they get a
 * useful non-empty default even without any configuration at all.
 *
 * An explicitly-set `REDIS_NAMESPACE` always wins, in any environment,
 * including production — an operator who deliberately sets it is trusted to
 * mean it (and `environment-isolation.guard.ts` already requires that, when
 * set, it identifies itself as staging).
 */

import { AppEnvironment, resolveAppEnv } from '../../config/app-env';
import type { EnvReader } from './redis-connection.util';

/**
 * Resolves the effective Redis key namespace. Never throws: an unresolvable
 * `APP_ENV` (the same defensive posture as `resolveAppEnvLabel`) degrades to
 * the empty namespace rather than crashing whatever cache/queue/lock factory
 * called it.
 */
export function resolveRedisNamespace(get: EnvReader): string {
  const explicit = get('REDIS_NAMESPACE');
  if (explicit !== undefined && explicit.trim() !== '') {
    return explicit.trim();
  }

  let appEnv: AppEnvironment;
  try {
    appEnv = resolveAppEnv(get);
  } catch {
    return '';
  }

  switch (appEnv) {
    case AppEnvironment.Staging: {
      return 'learnix:staging';
    }
    case AppEnvironment.Test: {
      return 'learnix:test';
    }
    default: {
      // Production and development both default to no namespace: production
      // for backward compatibility (see file header), development because a
      // single local Redis with unprefixed keys is what every existing
      // developer workflow already expects.
      return '';
    }
  }
}

/**
 * The namespace as a ready-to-concatenate prefix (trailing colon included),
 * or the empty string when there is no namespace. Suitable for `ioredis`'s
 * `keyPrefix` option, which concatenates literally with no separator of its
 * own.
 */
export function namespacedPrefix(get: EnvReader): string {
  const namespace = resolveRedisNamespace(get);
  return namespace === '' ? '' : `${namespace}:`;
}

/**
 * Prepends the namespace to an already-fully-formed key, e.g.
 * `namespacedKey(get, 'idempotency:webhook:123')` →
 * `learnix:staging:idempotency:webhook:123` on staging, or the key unchanged
 * on production (empty namespace).
 */
export function namespacedKey(get: EnvReader, key: string): string {
  return `${namespacedPrefix(get)}${key}`;
}

/**
 * BullMQ's own `prefix` queue option (default `'bull'`) already inserts its
 * own separators around the queue and job-key segments, so — unlike the
 * plain string helpers above — this returns `undefined` for "no namespace"
 * rather than `''`, letting BullMQ fall back to its own default prefix
 * exactly as it does today when the option is omitted entirely.
 */
export function bullMqPrefix(get: EnvReader): string | undefined {
  const namespace = resolveRedisNamespace(get);
  return namespace === '' ? undefined : namespace;
}
