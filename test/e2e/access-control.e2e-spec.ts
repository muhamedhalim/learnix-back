import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
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

  it('public GET /students lists only students who opted in (F-04)', async () => {
    const privateStudent = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const publicStudent = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    await ctx.dataSource.query(
      `UPDATE student_profiles SET is_public_profile = false WHERE user_id = $1`,
      [privateStudent.userId],
    );
    await ctx.dataSource.query(
      `UPDATE student_profiles SET is_public_profile = true WHERE user_id = $1`,
      [publicStudent.userId],
    );

    const list = await request(server).get(`${API_PREFIX}/students?limit=100`).expect(200);
    const ids = ((list.body.data ?? list.body) as { user: { id: string } }[]).map((r) => r.user.id);
    expect(ids).toContain(publicStudent.userId);
    expect(ids).not.toContain(privateStudent.userId);

    await request(server).get(`${API_PREFIX}/students/${publicStudent.userId}`).expect(200);
    await request(server).get(`${API_PREFIX}/students/${privateStudent.userId}`).expect(404);
  });

  it('requires the current password to change own email or phone (F-23)', async () => {
    const user = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const newEmail = `changed-${Date.now()}@example.test`;

    await user.agent.put(`${API_PREFIX}/users/me`).send({ email: newEmail }).expect(403);
    await user.agent
      .put(`${API_PREFIX}/users/me`)
      .send({ email: newEmail, current_password: 'wrong-password-123' })
      .expect(403);
    const [unchanged] = (await ctx.dataSource.query(`SELECT email FROM users WHERE id = $1`, [
      user.userId,
    ])) as { email: string }[];
    expect(unchanged?.email).toBe(user.credentials.email.toLowerCase());

    // A name change needs no password; an email change with the right one succeeds.
    await user.agent.put(`${API_PREFIX}/users/me`).send({ name: 'Renamed User' }).expect(200);
    await user.agent
      .put(`${API_PREFIX}/users/me`)
      .send({ email: newEmail, current_password: user.credentials.password })
      .expect(200);
  });

  it('rejects anonymous access to an admin-only route', async () => {
    await request(server).get(`${API_PREFIX}/admin/students`).expect(401);
  });

  it('rejects an authenticated student from an admin-only route', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    await agent.get(`${API_PREFIX}/admin/students`).expect(403);
  });

  it('role change is effective on the next request (admin -> student loses admin routes)', async () => {
    const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'admin',
    });
    await agent.get(`${API_PREFIX}/admin/students`).expect(200);

    await setUserRole(ctx.dataSource, userId, 'student');

    await agent.get(`${API_PREFIX}/admin/students`).expect(403);
  });

  it('returns 400 for a malformed registration body', async () => {
    await request(server).post(`${API_PREFIX}/auth/register`).send({ email: 'x' }).expect(400);
  });
});
