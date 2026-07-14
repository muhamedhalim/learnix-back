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

describe('cookie session CSRF protection (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EAppWithCsrf();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('sets a readable CSRF cookie but HttpOnly authentication cookies', async () => {
    const agent = request.agent(server);
    const csrf = await agent.get(`${API_PREFIX}/auth/csrf-token`).expect(200);
    const csrfToken = csrf.body.token as string;
    const xsrf = ((csrf.headers['set-cookie'] as unknown as string[]) ?? []).find((cookie) =>
      cookie.startsWith('XSRF-TOKEN='),
    );
    expect(xsrf).toBeDefined();
    expect(xsrf).not.toMatch(/HttpOnly/i);
    expect(xsrf).toMatch(/SameSite=Lax/i);

    const payload = buildRegisterPayload();
    const registration = await agent
      .post(`${API_PREFIX}/auth/register`)
      .set('X-CSRF-Token', csrfToken)
      .send(payload)
      .expect(201);
    await setUserStatus(ctx.dataSource, registration.body.userId as string, 'approved');

    const login = await agent
      .post(`${API_PREFIX}/auth/login`)
      .set('X-CSRF-Token', csrfToken)
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    expect(login.body).not.toHaveProperty('token');
    expect(login.body).not.toHaveProperty('accessToken');
    expect(login.body).not.toHaveProperty('refreshToken');
    const authCookies = ((login.headers['set-cookie'] as unknown as string[]) ?? []).filter(
      (cookie) => /^(access_token|refresh_token)=/.test(cookie),
    );
    expect(authCookies).toHaveLength(2);
    expect(authCookies.every((cookie) => /HttpOnly/i.test(cookie))).toBe(true);

    await agent.get(`${API_PREFIX}/users/me`).expect(200);
    await agent.post(`${API_PREFIX}/auth/refresh`).set('X-CSRF-Token', csrfToken).expect(200);
    await agent.post(`${API_PREFIX}/auth/logout`).set('X-CSRF-Token', csrfToken).expect(200);
  });

  it('rejects a mutating request with no CSRF header', async () => {
    const agent = request.agent(server);
    await agent.get(`${API_PREFIX}/auth/csrf-token`).expect(200);
    const response = await agent
      .post(`${API_PREFIX}/auth/register`)
      .send(buildRegisterPayload())
      .expect(403);
    expect(response.body.code).toBe('CSRF_TOKEN_MISSING');
  });

  it('rejects a header token when the signed cookie is absent', async () => {
    const csrf = await request(server).get(`${API_PREFIX}/auth/csrf-token`).expect(200);
    await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .set('X-CSRF-Token', csrf.body.token as string)
      .send({ email: 'nobody@example.com', password: 'Password123!' })
      .expect(403);
  });

  it('rejects a mismatched CSRF token', async () => {
    const agent = request.agent(server);
    await agent.get(`${API_PREFIX}/auth/csrf-token`).expect(200);
    await agent
      .post(`${API_PREFIX}/auth/register`)
      .set('X-CSRF-Token', 'wrong-token')
      .send(buildRegisterPayload())
      .expect(403);
  });
});
