import {
  buildAbsoluteUrl,
  isNonPublicHostname,
  parsePublicOrigin,
  validateProductionPublicOrigins,
} from './public-url.util';

describe('production public URL validation', () => {
  const valid = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://learn.example.com',
    BACKEND_URL: 'https://api.example.com',
    PUBLIC_MEDIA_BASE_URL: 'https://media.example.com',
    CORS_ORIGINS: 'https://learn.example.com,https://admin.example.com',
  };

  it('accepts explicit public HTTPS origins and builds canonical links', () => {
    expect(() => validateProductionPublicOrigins(valid)).not.toThrow();
    expect(buildAbsoluteUrl(valid.BACKEND_URL, '/api/v1/media/public/images/a.jpg')).toBe(
      'https://api.example.com/api/v1/media/public/images/a.jpg',
    );
  });

  it.each([
    'localhost',
    '127.0.0.1',
    '127.4.5.6',
    '10.0.0.8',
    '172.20.0.2',
    '192.168.1.2',
    '169.254.169.254',
    'api',
    'service.local',
    '::1',
  ])('classifies %s as non-public', (host) => {
    expect(isNonPublicHostname(host)).toBe(true);
  });

  it.each([
    'http://api.example.com',
    'https://localhost:3001',
    'https://10.0.0.2',
    'https://api',
    'ftp://api.example.com',
    'https://user:pass@api.example.com',
    'https://api.example.com/internal',
  ])('rejects an unsafe production origin: %s', (origin) => {
    expect(() => parsePublicOrigin(origin, 'BACKEND_URL', true)).toThrow();
  });

  it('fails startup validation when origins or credentialed CORS are unsafe', () => {
    expect(() =>
      validateProductionPublicOrigins({ ...valid, BACKEND_URL: 'https://localhost:3001' }),
    ).toThrow();
    expect(() => validateProductionPublicOrigins({ ...valid, CORS_ORIGINS: '*' })).toThrow();
    expect(() => validateProductionPublicOrigins({ ...valid, CORS_ORIGINS: undefined })).toThrow();
    expect(() =>
      validateProductionPublicOrigins({ ...valid, CORS_ORIGINS: 'https://other.example.com' }),
    ).toThrow('CORS_ORIGINS must include FRONTEND_URL');
  });
});
