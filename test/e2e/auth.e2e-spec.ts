import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  buildRegisterPayload,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserStatus,
  type E2EContext,
} from './fixtures';

/**
 * Authentication end-to-end tests against the real API contract:
 *   - registration is pending-by-default (no tokens returned)
 *   - login returns an access token + sets an HttpOnly refresh cookie
 *   - refresh rotates via the cookie (no token in the body)
 *   - logout invalidates the refresh cookie
 */
describe('Authentication (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('POST /auth/register', () => {
    it('registers a student as pending (no tokens issued)', async () => {
      const payload = buildRegisterPayload();
      const res = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(payload)
        .expect(201);

      expect(res.body).toHaveProperty('userId');
      expect(res.body).not.toHaveProperty('token');
      expect(String(res.body.message)).toMatch(/pending/i);
    });

    it('rejects a duplicate email/phone generically', async () => {
      const payload = buildRegisterPayload();
      await request(server).post(`${API_PREFIX}/auth/register`).send(payload).expect(201);
      await request(server).post(`${API_PREFIX}/auth/register`).send(payload).expect(409);
    });

    it('rejects an invalid email (validation error)', async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(buildRegisterPayload({ email: 'not-an-email' }))
        .expect(400);
    });
  });

  describe('POST /auth/login', () => {
    it('returns a pending status for an unapproved account', async () => {
      const payload = buildRegisterPayload();
      await request(server).post(`${API_PREFIX}/auth/register`).send(payload).expect(201);

      const res = await request(server)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: payload.email, password: payload.password })
        .expect(200);

      expect(res.body.status).toBe('pending');
      expect(res.body).not.toHaveProperty('token');
    });

    it('issues an access token and refresh cookie once approved', async () => {
      const payload = buildRegisterPayload();
      const reg = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(payload)
        .expect(201);
      await setUserStatus(ctx.dataSource, reg.body.userId as string, 'approved');

      const res = await request(server)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: payload.email, password: payload.password })
        .expect(200);

      expect(res.body.status).toBe('approved');
      expect(res.body.token).toEqual(expect.any(String));
      // Refresh token is delivered as an HttpOnly cookie, never in the body.
      expect(res.body).not.toHaveProperty('refreshToken');
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.join(';')).toMatch(/refresh_token=/);
    });

    it('rejects invalid credentials with 401', async () => {
      const payload = buildRegisterPayload();
      const reg = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(payload)
        .expect(201);
      await setUserStatus(ctx.dataSource, reg.body.userId as string, 'approved');

      await request(server)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: payload.email, password: 'WrongPassword123!' })
        .expect(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates tokens using the HttpOnly cookie', async () => {
      const { agent, token } = await createAuthenticatedUser(ctx.app, ctx.dataSource);

      const res = await agent.post(`${API_PREFIX}/auth/refresh`).expect(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.token).not.toBe(token);
    });

    it('rejects a refresh with no cookie', async () => {
      await request(server).post(`${API_PREFIX}/auth/refresh`).expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('logs out and invalidates the refresh cookie', async () => {
      const { agent, token } = await createAuthenticatedUser(ctx.app, ctx.dataSource);

      await agent
        .post(`${API_PREFIX}/auth/logout`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // The rotated/cleared cookie can no longer refresh.
      await agent.post(`${API_PREFIX}/auth/refresh`).expect(401);
    });

    it('requires authentication', async () => {
      await request(server).post(`${API_PREFIX}/auth/logout`).expect(401);
    });
  });
});
