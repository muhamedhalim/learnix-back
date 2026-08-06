import 'reflect-metadata';

import {
  AppEnvironment,
  MissingAppEnvError,
  recordReader,
  resolveAppEnv,
  resolveAppEnvLabel,
  UnsupportedAppEnvError,
} from './app-env';

function reader(values: Record<string, string | undefined>) {
  return (key: string): string | undefined => values[key];
}

describe('resolveAppEnv', () => {
  it('derives production from NODE_ENV=production when APP_ENV is absent', () => {
    expect(resolveAppEnv(reader({ NODE_ENV: 'production' }))).toBe(AppEnvironment.Production);
  });

  it('derives test and development from NODE_ENV', () => {
    expect(resolveAppEnv(reader({ NODE_ENV: 'test' }))).toBe(AppEnvironment.Test);
    expect(resolveAppEnv(reader({ NODE_ENV: 'development' }))).toBe(AppEnvironment.Development);
  });

  it('derives development for an unset or unrecognised NODE_ENV, never production', () => {
    expect(resolveAppEnv(reader({}))).toBe(AppEnvironment.Development);
    expect(resolveAppEnv(reader({ NODE_ENV: 'prod' }))).toBe(AppEnvironment.Development);
  });

  it('prefers an explicit APP_ENV over the NODE_ENV derivation', () => {
    expect(resolveAppEnv(reader({ NODE_ENV: 'production', APP_ENV: 'staging' }))).toBe(
      AppEnvironment.Staging,
    );
  });

  it('normalises case and surrounding whitespace', () => {
    expect(resolveAppEnv(reader({ APP_ENV: '  STAGING  ' }))).toBe(AppEnvironment.Staging);
  });

  it('rejects an unsupported APP_ENV value', () => {
    expect(() => resolveAppEnv(reader({ APP_ENV: 'stage' }))).toThrow(UnsupportedAppEnvError);
  });

  it('requires an explicit APP_ENV when APP_ENV_STRICT=true', () => {
    expect(() =>
      resolveAppEnv(reader({ NODE_ENV: 'production', APP_ENV_STRICT: 'true' })),
    ).toThrow(MissingAppEnvError);
  });
});

describe('resolveAppEnvLabel', () => {
  it('returns the resolved AppEnvironment as a plain string for a valid config', () => {
    expect(resolveAppEnvLabel(reader({ NODE_ENV: 'production', APP_ENV: 'staging' }))).toBe(
      'staging',
    );
    expect(resolveAppEnvLabel(reader({ NODE_ENV: 'production' }))).toBe('production');
  });

  it('NEVER throws, even for a malformed APP_ENV — labels must never crash a caller', () => {
    expect(() => resolveAppEnvLabel(reader({ APP_ENV: 'not-a-real-environment' }))).not.toThrow();
  });

  it('falls back to the raw NODE_ENV value when APP_ENV is malformed', () => {
    expect(
      resolveAppEnvLabel(reader({ NODE_ENV: 'production', APP_ENV: 'not-a-real-environment' })),
    ).toBe('production');
  });

  it('falls back to "development" when both APP_ENV and NODE_ENV are absent', () => {
    expect(resolveAppEnvLabel(reader({}))).toBe('development');
  });

  it('never throws under APP_ENV_STRICT even without an explicit APP_ENV', () => {
    expect(() => resolveAppEnvLabel(reader({ APP_ENV_STRICT: 'true' }))).not.toThrow();
  });

  it('is what every Sentry/health/log label call site now uses instead of raw NODE_ENV', () => {
    // Documents the fix for docs/NODE_ENV_AUDIT.md #5, #15, #16, #21, #31 (backend)
    // and the frontend Sentry instrumentation: a staging deployment's label must
    // read "staging", not "production", even though NODE_ENV is "production".
    const stagingRuntimeEnv = { NODE_ENV: 'production', APP_ENV: 'staging' };
    expect(resolveAppEnvLabel(reader(stagingRuntimeEnv))).toBe('staging');
    expect(reader(stagingRuntimeEnv)('NODE_ENV')).toBe('production');
  });
});

describe('recordReader', () => {
  it('adapts a plain config object into an EnvReader', () => {
    const read = recordReader({ APP_ENV: 'staging', PORT: 3000, ENABLED: true });
    expect(read('APP_ENV')).toBe('staging');
    // Non-string values are not coerced — they resolve to undefined, matching
    // how class-validator's plainToInstance config objects are consumed
    // elsewhere in this codebase.
    expect(read('PORT')).toBeUndefined();
    expect(read('MISSING')).toBeUndefined();
  });
});
