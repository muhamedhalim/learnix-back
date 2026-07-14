import { getAllowedOrigins, isOriginAllowed } from './cors.util';

describe('credentialed CORS allowlist', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalOrigins = process.env['CORS_ORIGINS'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
    if (originalOrigins === undefined) delete process.env['CORS_ORIGINS'];
    else process.env['CORS_ORIGINS'] = originalOrigins;
  });

  it('uses only the production site by default in production', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['CORS_ORIGINS'];
    expect(getAllowedOrigins()).toEqual(['https://learnix.school']);
  });

  it('matches configured origins exactly and rejects suffix lookalikes', () => {
    process.env['CORS_ORIGINS'] = 'https://learnix.school, https://admin.learnix.school/';
    const allowed = getAllowedOrigins();
    expect(isOriginAllowed('https://admin.learnix.school', allowed)).toBe(true);
    expect(isOriginAllowed('https://learnix.school.attacker.example', allowed)).toBe(false);
    expect(isOriginAllowed('https://preview.vercel.app', allowed)).toBe(false);
  });
});
