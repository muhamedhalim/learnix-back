import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  buildRegisterPayload,
  createE2EAppWithCsrf,
  resetDatabase,
  setUserStatus,
  type E2EContext,
} from './fixtures';

/**
 * CSRF bootstrap + login end-to-end tests (with the real CsrfGuard installed —
 * see createE2EAppWithCsrf).
 *
 * Regression coverage for a bug where the XSRF-TOKEN cookie's Secure/SameSite
 * attributes were derived from `NODE_ENV` alone: if `NODE_ENV` ever read
 * "production" while the request was actually plain HTTP (as in this test
 * run), the browser would silently drop a `Secure` cookie, leaving the header
 * present but the cookie half of the double-submit pair missing — a 403
 * "CSRF token missing" on an otherwise-correct login. The fix derives the
 * cookie attributes from the request's actual TLS state
 * (getCrossSiteCookieOptions), so these tests assert the cookie is both
 * present AND has the attributes appropriate for a non-HTTPS test run.
 */
describe('CSRF bootstrap + login (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EAppWithCsrf();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('GET /auth/csrf-token sets a Lax, non-Secure cookie over plain HTTP', async () => {
    const res = await request(server).get(`${API_PREFIX}/auth/csrf-token`).expect(200);

    expect(res.body.token).toEqual(expect.any(String));

    const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const xsrfCookie = setCookie.find((c) => c.startsWith('XSRF-TOKEN='));
    expect(xsrfCookie).toBeDefined();

    // This E2E run is plain HTTP (supertest, no TLS) — the cookie must never
    // claim Secure/SameSite=None here, or the browser would drop it entirely.
    expect(xsrfCookie).not.toMatch(/;\s*Secure/i);
    expect(xsrfCookie).toMatch(/SameSite=Lax/i);
  });

  it('completes register → bootstrap CSRF → login using the cookie + header together', async () => {
    const agent = request.agent(server);
    const payload = buildRegisterPayload();

    const reg = await agent
      .post(`${API_PREFIX}/auth/register`)
      .send(payload)
      .expect(201);
    await setUserStatus(ctx.dataSource, reg.body.userId as string, 'approved');

    // Bootstrap: the agent's cookie jar picks up XSRF-TOKEN from Set-Cookie.
    const csrfRes = await agent.get(`${API_PREFIX}/auth/csrf-token`).expect(200);
    const csrfToken = csrfRes.body.token as string;
    expect(csrfToken).toEqual(expect.any(String));

    // Login is a state-changing request — requires the header to match the
    // cookie the agent is now carrying.
    const loginRes = await agent
      .post(`${API_PREFIX}/auth/login`)
      .set('X-CSRF-Token', csrfToken)
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    expect(loginRes.body.status).toBe('approved');
    expect(loginRes.body.token).toEqual(expect.any(String));
  });

  it('still rejects a state-changing request with the header but no cookie (CSRF not weakened)', async () => {
    const payload = buildRegisterPayload();
    const reg = await request(server)
      .post(`${API_PREFIX}/auth/register`)
      .send(payload)
      .expect(201);
    await setUserStatus(ctx.dataSource, reg.body.userId as string, 'approved');

    // Fetch a token value but do NOT reuse the agent/cookie jar that received it.
    const csrfRes = await request(server).get(`${API_PREFIX}/auth/csrf-token`);
    const csrfToken = csrfRes.body.token as string;

    await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .set('X-CSRF-Token', csrfToken)
      .send({ email: payload.email, password: payload.password })
      .expect(403);
  });

  it('rejects any state-changing request with no header at all', async () => {
    const agent = request.agent(server);

    // register is itself state-changing: it must be blocked before the CSRF
    // cookie has even been bootstrapped.
    await agent.post(`${API_PREFIX}/auth/register`).send(buildRegisterPayload()).expect(403);
  });

  it('rejects login with the cookie present but a missing header', async () => {
    const agent = request.agent(server);
    const payload = buildRegisterPayload();

    // Bootstrap the CSRF cookie via a safe GET, but never attach the header.
    await agent.get(`${API_PREFIX}/auth/csrf-token`).expect(200);
    await agent
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: payload.email, password: payload.password })
      .expect(403);
  });
});
