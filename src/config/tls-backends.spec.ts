import 'reflect-metadata';

import { validate, validateTlsBackends } from './env.validation';

describe('validateTlsBackends', () => {
  const base = { DATABASE_URL: 'postgres://u:p@db.example.rds.amazonaws.com:5432/app' };

  it('does nothing unless REQUIRE_TLS_BACKENDS=true', () => {
    expect(() => validateTlsBackends({ ...base, REDIS_URL: 'redis://cache:6379' })).not.toThrow();
  });

  it('accepts rediss:// and a remote verified database', () => {
    expect(() =>
      validateTlsBackends({ ...base, REQUIRE_TLS_BACKENDS: 'true', REDIS_URL: 'rediss://cache:6379' }),
    ).not.toThrow();
  });

  it('rejects plaintext Redis', () => {
    expect(() =>
      validateTlsBackends({ ...base, REQUIRE_TLS_BACKENDS: 'true', REDIS_URL: 'redis://cache:6379' }),
    ).toThrow(/rediss/);
  });

  it('rejects plaintext Redis built from host/port parts', () => {
    expect(() =>
      validateTlsBackends({ ...base, REQUIRE_TLS_BACKENDS: 'true', REDIS_HOST: 'cache' }),
    ).toThrow(/rediss/);
  });

  it('rejects disabling certificate verification', () => {
    expect(() =>
      validateTlsBackends({
        ...base,
        REQUIRE_TLS_BACKENDS: 'true',
        REDIS_URL: 'rediss://cache:6379',
        SSL_REJECT_UNAUTHORIZED: 'false',
      }),
    ).toThrow(/SSL_REJECT_UNAUTHORIZED/);
  });

  it('rejects a loopback database', () => {
    expect(() =>
      validateTlsBackends({
        DATABASE_URL: 'postgres://u:p@localhost:5432/app',
        REQUIRE_TLS_BACKENDS: 'true',
        REDIS_URL: 'rediss://cache:6379',
      }),
    ).toThrow(/loopback/);
  });
});

describe('validate() runtime knobs', () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/app',
    JWT_SECRET: 'x'.repeat(40),
    JWT_REFRESH_SECRET: 'y'.repeat(40),
    COOKIE_SECRET: 'z'.repeat(40),
    INIT_SECRET: 'w'.repeat(40),
  };

  it('rejects a bad TRUST_PROXY_HOPS at boot', () => {
    expect(() => validate({ ...env, TRUST_PROXY_HOPS: '9' })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('rejects an unknown LOG_FORMAT at boot', () => {
    expect(() => validate({ ...env, LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT/);
  });
});
