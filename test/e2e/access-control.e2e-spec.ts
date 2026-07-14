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
 * Access-control & data-exposure end-to-end tests:
 *   - public listings never expose PII
 *   - role-guarded admin routes reject anonymous callers
 *   - validation errors are returned as 400
 */
describe('Access control (e2e)', () => {
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

  it('public GET /students never exposes email/phone/parent_phone', async () => {
    // Seed one approved student (registration creates the student profile).
    await createAuthenticatedUser(ctx.app, ctx.dataSource);

    const res = await request(server).get(`${API_PREFIX}/students`).expect(200);

    const rows = (res.body.data ?? res.body) as unknown[];
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/"email"/);
    expect(serialized).not.toMatch(/"phone"/);
    expect(serialized).not.toMatch(/"parent_phone"/);
  });

  it('rejects anonymous access to an admin-only route', async () => {
    await request(server).get(`${API_PREFIX}/admin/students`).expect(401);
  });

  it('rejects an authenticated student from an admin-only route', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    await agent.get(`${API_PREFIX}/admin/students`).expect(403);
  });

  it('returns 400 for a malformed registration body', async () => {
    await request(server).post(`${API_PREFIX}/auth/register`).send({ email: 'x' }).expect(400);
  });
});
