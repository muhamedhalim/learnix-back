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
    'http://accept.paymob.com',
    'https://attacker.example',
    'https://key@accept.paymob.com',
    'https://accept.paymob.com/?redirect=https://attacker.example',
    'not a url',
  ])('rejects unsafe PAYMOB_BASE_URL=%s', (url) => {
    expect(() => validate({ ...baseProductionConfig, PAYMOB_BASE_URL: url })).toThrow(
      /PAYMOB_BASE_URL/i,
    );
  });

  it.each(['https://accept.paymob.com', 'https://accept.paymobsolutions.com/api'])(
    'accepts allowlisted PAYMOB_BASE_URL=%s',
    (url) => {
      expect(() => validate({ ...baseProductionConfig, PAYMOB_BASE_URL: url })).not.toThrow();
    },
  );
});
