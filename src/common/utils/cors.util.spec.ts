import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import request from 'supertest';

import { buildCorsOptions, getAllowedOrigins, isOriginAllowed } from './cors.util';

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

  it('REGRESSION (finding A-17): the non-production fallback never names the production origin', () => {
    // A staging or development boot that forgets to set CORS_ORIGINS must not
    // silently start trusting the real production frontend as a credentialed
    // CORS origin. See docs/NODE_ENV_AUDIT.md #10.
    delete process.env['NODE_ENV'];
    delete process.env['CORS_ORIGINS'];
    const fallback = getAllowedOrigins();
    expect(fallback).not.toContain('https://learnix.school');
    expect(isOriginAllowed('https://learnix.school', fallback)).toBe(false);
  });
});

describe('Vercel frontend -> AWS API (separate origins) credentialed CORS over HTTP', () => {
  const FRONTEND = 'https://learnix.school';
  const blocked: string[] = [];

  const app = express();
  app.use(cookieParser('test-secret'));
  app.use(cors(buildCorsOptions(getAllowedFor(FRONTEND), (o) => blocked.push(o))));
  app.post('/api/v1/auth/login', (_req, res) => {
    res.cookie('access_token', 'v', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
    });
    res.json({ ok: true });
  });
  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));

  function getAllowedFor(origins: string): string[] {
    const original = process.env['CORS_ORIGINS'];
    process.env['CORS_ORIGINS'] = origins;
    try {
      return getAllowedOrigins();
    } finally {
      if (original === undefined) delete process.env['CORS_ORIGINS'];
      else process.env['CORS_ORIGINS'] = original;
    }
  }

  const preflight = (origin: string) =>
    request(app)
      .options('/api/v1/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');

  it('answers the frontend origin with credentials, an echoed origin (never *) and the CSRF header allowed', async () => {
    const res = await preflight(FRONTEND);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toMatch(/x-csrf-token/i);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('lets the browser read the response of a credentialed call and keeps the cookie SameSite=None; Secure; Partitioned', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', FRONTEND);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=None/);
    expect(cookie).toMatch(/Partitioned/);
  });

  it.each([
    ['a Vercel preview URL', 'https://learnix-git-feature-team.vercel.app'],
    ['the staging frontend', 'https://staging.learnix.school'],
    ['a look-alike suffix', 'https://learnix.school.attacker.example'],
    ['the API host itself', 'https://api.learnix.school'],
    ['the plain-http frontend', 'http://learnix.school'],
    ['null (sandboxed iframe)', 'null'],
  ])('sends no CORS headers to %s', async (_label, origin) => {
    const res = await preflight(origin);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(blocked).toContain(origin);
  });

  it('does not treat requests without an Origin header (webhooks, health checks) as CORS requests', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('allows the Idempotency-Key header the frontend sends on admin/marketplace writes (F-09)', async () => {
    const res = await request(app)
      .options('/api/v1/health')
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key,x-csrf-token');
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain('idempotency-key');
  });
});
