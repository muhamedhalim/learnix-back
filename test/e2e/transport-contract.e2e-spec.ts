import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

import request from 'supertest';

import { collectRoutes } from './helpers/route-collector';
import { API_PREFIX, createE2EAppWithCsrf, type E2EContext } from './fixtures';

/**
 * Transport contract for a browser on another origin (Phase 3, F-09 / TC-SEC-02 / TC-AUTH-13).
 *
 * The default e2e app has neither CORS nor CSRF, so no other suite could have caught the
 * `Idempotency-Key` preflight failure. This one boots the production policies.
 */
const FRONTEND = 'https://learnix.school';
/** Every custom request header the frontend client sets (see learnix-front test/cors-contract.test.ts). */
const CLIENT_HEADERS = ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'Accept-Language'];

/** The only mutating routes allowed to bypass CSRF: operator bootstrap and provider callbacks. */
const EXPECTED_CSRF_EXEMPT = new Set([
  'POST /api/v1/init-admin',
  'POST /api/v1/webhooks/whatsapp',
  // Zoom signs each delivery with an HMAC over the raw body; CSRF tokens do not apply (@SkipCsrf).
  'POST /api/v1/webhooks/zoom',
  'POST /api/v1/payments/webhook',
  'POST /api/v1/payments/webhook/callback',
]);

describe('transport contract (CORS + CSRF over every route)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EAppWithCsrf({ corsOrigins: [FRONTEND] });
    app = ctx.app;
    server = app.getHttpServer() as Server;
  });
  afterAll(async () => app.close());

  describe('CORS preflight', () => {
    it('allows the frontend origin with credentials and every header the client sends', async () => {
      const res = await request(server)
        .options(`${API_PREFIX}/admin/notifications`)
        .set('Origin', FRONTEND)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', CLIENT_HEADERS.join(', '))
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
      for (const header of CLIENT_HEADERS.filter((h) => h !== 'Accept-Language')) {
        expect(allowed).toContain(header.toLowerCase());
      }
    });

    it('does not grant a foreign origin credentialed access', async () => {
      const res = await request(server)
        .options(`${API_PREFIX}/admin/notifications`)
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type, X-CSRF-Token');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('CSRF', () => {
    it('rejects every state-changing route that has no token, except the audited exemptions', async () => {
      const routes = collectRoutes(app).filter((r) => r.httpMethod !== 'get');
      expect(routes.length).toBeGreaterThan(100);

      const exempt: string[] = [];
      const unprotected: string[] = [];
      for (const route of routes) {
        const res = await request(server)[route.httpMethod as 'post'](route.concretePath).send({});
        const csrfBlocked =
          res.status === 403 && /CSRF_TOKEN_(MISSING|INVALID)/.test(JSON.stringify(res.body));
        if (!csrfBlocked) {
          const key = `${route.method} ${route.path}`;
          exempt.push(key);
          if (!EXPECTED_CSRF_EXEMPT.has(key)) unprotected.push(`${key} -> ${String(res.status)}`);
        }
      }
      expect(unprotected).toEqual([]);
      // Guard against the allow-list silently going stale.
      for (const name of EXPECTED_CSRF_EXEMPT) expect(exempt).toContain(name);
    });
  });
});
