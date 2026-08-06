import 'reflect-metadata';

import { THROTTLE } from '../constants';
import { resolveLoginThrottle } from './login-throttle';

/** Builds an EnvReader over a plain object, mirroring `processEnvReader`. */
function reader(values: Record<string, string | undefined>) {
  return (key: string): string | undefined => values[key];
}

describe('login throttle — production', () => {
  it('uses THROTTLE.AUTH when APP_ENV is absent and NODE_ENV is production', () => {
    expect(resolveLoginThrottle(reader({ NODE_ENV: 'production' }))).toEqual(THROTTLE.AUTH);
  });

  it('uses THROTTLE.AUTH when APP_ENV is explicitly production', () => {
    expect(resolveLoginThrottle(reader({ NODE_ENV: 'production', APP_ENV: 'production' }))).toEqual(
      THROTTLE.AUTH,
    );
  });

  it('IGNORES a relaxed override on production — the limit cannot be raised', () => {
    const resolved = resolveLoginThrottle(
      reader({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        LOGIN_THROTTLE_LIMIT: '150',
        LOGIN_THROTTLE_TTL_MS: '60000',
      }),
    );
    expect(resolved).toEqual(THROTTLE.AUTH);
    expect(resolved.limit).toBe(5);
    expect(resolved.ttl).toBe(300_000);
  });

  it('falls back to THROTTLE.AUTH when APP_ENV is malformed, never to a relaxed tier', () => {
    const resolved = resolveLoginThrottle(
      reader({ APP_ENV: 'not-an-environment', LOGIN_THROTTLE_LIMIT: '150' }),
    );
    expect(resolved).toEqual(THROTTLE.AUTH);
  });

  it('restores the 150/min tier that was live in production', () => {
    // Regression guard for the exact defect this change fixes.
    const resolved = resolveLoginThrottle(reader({ NODE_ENV: 'production' }));
    expect(resolved.limit).not.toBe(150);
    expect(resolved.limit).toBeLessThanOrEqual(5);
  });
});

describe('login throttle — non-production', () => {
  it('defaults to THROTTLE.AUTH on staging when no override is supplied', () => {
    expect(resolveLoginThrottle(reader({ NODE_ENV: 'production', APP_ENV: 'staging' }))).toEqual(
      THROTTLE.AUTH,
    );
  });

  it('honours a relaxed override on staging for automated QA', () => {
    const resolved = resolveLoginThrottle(
      reader({
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        LOGIN_THROTTLE_LIMIT: '150',
        LOGIN_THROTTLE_TTL_MS: '60000',
      }),
    );
    expect(resolved).toEqual({ limit: 150, ttl: 60_000 });
  });

  it('honours an override in development', () => {
    const resolved = resolveLoginThrottle(
      reader({ NODE_ENV: 'development', LOGIN_THROTTLE_LIMIT: '50' }),
    );
    expect(resolved.limit).toBe(50);
  });

  it('clamps an absurd limit rather than disabling the limiter', () => {
    const resolved = resolveLoginThrottle(
      reader({ APP_ENV: 'staging', LOGIN_THROTTLE_LIMIT: '100000' }),
    );
    expect(resolved.limit).toBe(200);
  });

  it('enforces a minimum window so the limiter cannot be neutered by a tiny TTL', () => {
    const resolved = resolveLoginThrottle(
      reader({ APP_ENV: 'staging', LOGIN_THROTTLE_LIMIT: '50', LOGIN_THROTTLE_TTL_MS: '1' }),
    );
    expect(resolved.ttl).toBe(1_000);
  });

  it.each(['0', '-5', 'abc', ''])('ignores the invalid override value %s', (value) => {
    const resolved = resolveLoginThrottle(
      reader({ APP_ENV: 'staging', LOGIN_THROTTLE_LIMIT: value }),
    );
    expect(resolved).toEqual(THROTTLE.AUTH);
  });

  it('keeps the AUTH ttl when only the limit is overridden', () => {
    const resolved = resolveLoginThrottle(
      reader({ APP_ENV: 'staging', LOGIN_THROTTLE_LIMIT: '40' }),
    );
    expect(resolved).toEqual({ limit: 40, ttl: THROTTLE.AUTH.ttl });
  });
});

describe('THROTTLE tiers', () => {
  it('no longer exposes the temporary login tier', () => {
    expect(THROTTLE).not.toHaveProperty('LOGIN_TESTSPRITE_TEMPORARY');
  });

  it('keeps AUTH at 5 attempts per 5 minutes', () => {
    expect(THROTTLE.AUTH).toEqual({ ttl: 300_000, limit: 5 });
  });
});
