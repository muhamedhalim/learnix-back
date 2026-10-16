import 'reflect-metadata';

import { validate } from './env.validation';

const baseProductionConfig: Record<string, unknown> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:password@db.example.test:5432/app',
  JWT_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  FRONTEND_URL: 'https://learn.example.test',
  BACKEND_URL: 'https://api.example.test',
  PUBLIC_MEDIA_BASE_URL: 'https://media.example.test',
  CORS_ORIGINS: 'https://learn.example.test,https://admin.example.test',
  PAYMENT_CAPTURE_GRACE_SECONDS: '300',
  PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS: '120',
};

describe('production environment URL validation', () => {
  it('accepts explicitly configured public HTTPS origins', () => {
    expect(() => validate(baseProductionConfig)).not.toThrow();
  });

  it.each(['FRONTEND_URL', 'BACKEND_URL', 'CORS_ORIGINS'])(
    'fails startup when %s is missing',
    (variable) => {
      const config = { ...baseProductionConfig };
      delete config[variable];
      expect(() => validate(config)).toThrow(new RegExp(variable));
    },
  );

  it.each([
    ['FRONTEND_URL', 'http://learn.example.test'],
    ['BACKEND_URL', 'https://localhost:3001'],
    ['PUBLIC_MEDIA_BASE_URL', 'https://127.0.0.1'],
    ['PUBLIC_MEDIA_BASE_URL', 'https://10.0.0.4'],
    ['PUBLIC_MEDIA_BASE_URL', 'file:///tmp/media'],
  ])('rejects unsafe production %s=%s', (variable, value) => {
    expect(() => validate({ ...baseProductionConfig, [variable]: value })).toThrow();
  });

  it('rejects wildcard or mismatched credentialed CORS origins', () => {
    expect(() => validate({ ...baseProductionConfig, CORS_ORIGINS: '*' })).toThrow(/wildcard/i);
    expect(() =>
      validate({ ...baseProductionConfig, CORS_ORIGINS: 'https://other.example.test' }),
    ).toThrow(/include FRONTEND_URL/i);
  });

  it.each([
    'http://back.easykash.net',
    'https://attacker.example',
    'https://key@back.easykash.net',
    'https://back.easykash.net/?redirect=https://attacker.example',
    'https://back.easykash.net/api',
    'not a url',
  ])('rejects unsafe EASYKASH_API_BASE_URL=%s', (url) => {
    expect(() =>
      validate({
        ...baseProductionConfig,
        EASYKASH_API_KEY: 'k',
        EASYKASH_HMAC_SECRET: 's',
        EASYKASH_API_BASE_URL: url,
      }),
    ).toThrow(/EASYKASH_API_BASE_URL/i);
  });

  it.each(['https://back.easykash.net', 'https://back.easykash.net/'])(
    'accepts allowlisted EASYKASH_API_BASE_URL=%s',
    (url) => {
      expect(() =>
        validate({
          ...baseProductionConfig,
          EASYKASH_API_KEY: 'k',
          EASYKASH_HMAC_SECRET: 's',
          EASYKASH_API_BASE_URL: url,
        }),
      ).not.toThrow();
    },
  );

  it('requires the HMAC secret whenever EasyKash is configured', () => {
    expect(() => validate({ ...baseProductionConfig, EASYKASH_API_KEY: 'k' })).toThrow(
      /EASYKASH_HMAC_SECRET is required/,
    );
  });

  it.each(['abc', '0', '73', '1.5'])('rejects EASYKASH_CASH_EXPIRY_HOURS=%s', (hours) => {
    expect(() =>
      validate({
        ...baseProductionConfig,
        EASYKASH_API_KEY: 'k',
        EASYKASH_HMAC_SECRET: 's',
        EASYKASH_CASH_EXPIRY_HOURS: hours,
      }),
    ).toThrow(/EASYKASH_CASH_EXPIRY_HOURS/);
  });

  it('rejects an undocumented payment option id', () => {
    expect(() =>
      validate({
        ...baseProductionConfig,
        EASYKASH_API_KEY: 'k',
        EASYKASH_HMAC_SECRET: 's',
        EASYKASH_PAYMENT_OPTIONS: '2,999',
      }),
    ).toThrow(/EASYKASH_PAYMENT_OPTIONS/);
  });
});
