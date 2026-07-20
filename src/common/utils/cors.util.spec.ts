import { getAllowedOrigins, isOriginAllowed } from './cors.util';

describe('credentialed CORS allowlist', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalOrigins = process.env['CORS_ORIGINS'];

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    if (originalOrigins === undefined) delete process.env['CORS_ORIGINS'];
    else process.env['CORS_ORIGINS'] = originalOrigins;
  });

  it('fails closed when the production allowlist is missing', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['CORS_ORIGINS'];
    expect(() => getAllowedOrigins()).toThrow('CORS_ORIGINS is required in production');
  });

  it('matches configured origins exactly and rejects suffix lookalikes', () => {
    process.env['CORS_ORIGINS'] = 'https://learnix.school, https://admin.learnix.school/';
    const allowed = getAllowedOrigins();
    expect(isOriginAllowed('https://admin.learnix.school', allowed)).toBe(true);
    expect(isOriginAllowed('https://learnix.school.attacker.example', allowed)).toBe(false);
    expect(isOriginAllowed('https://preview.vercel.app', allowed)).toBe(false);
  });
});
