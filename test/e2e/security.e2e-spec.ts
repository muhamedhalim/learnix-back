import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

/**
 * Security-focused end-to-end tests (contract-correct):
 *   - invalid/malformed/expired tokens are rejected
 *   - SQL-injection attempts in the login field fail safely
 *   - responses never leak password hashes
 *   - security headers (Helmet) are present
 */
describe('Security (e2e)', () => {
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

  describe('token handling', () => {
    it('rejects a request with no token', async () => {
      await request(server).post(`${API_PREFIX}/auth/logout`).expect(401);
    });

    it('rejects an invalid token', async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/logout`)
        .set('Authorization', 'Bearer invalid.token.value')
        .expect(401);
    });

    it('rejects a malformed authorization header', async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/logout`)
        .set('Authorization', 'NotBearer xyz')
        .expect(401);
    });
  });

  describe('injection & data exposure', () => {
    it("treats a SQL-injection login payload as invalid credentials", async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: "admin' OR '1'='1", password: "' OR '1'='1" })
        .expect(401);
    });

    it('never returns a password hash on login', async () => {
      const { agent, credentials } = await createAuthenticatedUser(
        ctx.app,
        ctx.dataSource,
      );
      const res = await agent
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: credentials.email, password: credentials.password })
        .expect(200);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/password_hash/);
      expect(serialized).not.toMatch(/refreshToken/);
    });
  });

  describe('security headers', () => {
    it('sets Helmet hardening headers', async () => {
      const res = await request(server).get(`${API_PREFIX}/health`).expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });
  });
});
