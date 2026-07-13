/** Reads one env var by name. Satisfied by `process.env` directly (needed in
 * static `@Module()` metadata, evaluated before Nest's DI container exists)
 * or by `ConfigService.get.bind(configService)` (once DI is available). */
export type EnvReader = (key: string) => string | undefined;

/** `(key) => process.env[key]` — the only reader available before Nest's DI
 * container exists (e.g. inside a static `@Module()` `imports` array). */
export function processEnvReader(): EnvReader {
  return (key) => process.env[key];
}

/**
 * Builds a `redis://` URL from `REDIS_URL`, or from the
 * `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` parts, or returns `undefined`
 * when neither is configured (local development with no Redis).
 *
 * Single source of truth for "is Redis configured" — used by the cache store
 * and rate-limiter storage (via a `ConfigService`-backed reader, in
 * `app.module.ts`) and by BullMQ's queue registration (via `processEnvReader`,
 * since that decision is made in static module metadata before DI exists).
 */
export function resolveRedisUrl(get: EnvReader): string | undefined {
  const explicitUrl = get('REDIS_URL');
  if (explicitUrl !== undefined && explicitUrl !== '') {
    return explicitUrl;
  }

  const host = get('REDIS_HOST');
  if (host === undefined || host === '') {
    return undefined;
  }

  const port = get('REDIS_PORT') ?? '6379';
  const password = get('REDIS_PASSWORD');

  return password !== undefined && password !== ''
    ? `redis://:${password}@${host}:${port}`
    : `redis://${host}:${port}`;
}
