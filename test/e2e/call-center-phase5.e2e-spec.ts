import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

describe('Call Center Phase 5 user lookup and support actions (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('returns a minimal student/teacher-only support projection and protects the legacy Admin surface', async () => {
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });

    await request(server).get(`${API_PREFIX}/callcenter/users`).expect(401);
    await student.agent.get(`${API_PREFIX}/callcenter/users`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/callcenter/users`).expect(403);
    await admin.agent.get(`${API_PREFIX}/callcenter/users`).expect(403);
    await support.agent.get(`${API_PREFIX}/callcenter/students`).expect(403);
    await support.agent
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({ name: 'Blocked' })
      .expect(403);
    await admin.agent.get(`${API_PREFIX}/callcenter/students`).expect(200);

    const list = await support.agent
      .get(`${API_PREFIX}/callcenter/users`)
      .query({ search: student.credentials.email, page: 1, limit: 20 })
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: student.userId, role: 'student' });
    expect(list.body.data[0]).not.toHaveProperty('password_hash');
    expect(list.body.data[0]).not.toHaveProperty('finance_permissions');

    const detail = await support.agent
      .get(`${API_PREFIX}/callcenter/users/${teacher.userId}`)
      .expect(200);
    expect(detail.body.user).toMatchObject({ id: teacher.userId, role: 'teacher' });
    expect(detail.body).not.toHaveProperty('payments');
    expect(detail.body).not.toHaveProperty('sessions');

    const agents = await support.agent.get(`${API_PREFIX}/callcenter/agents`).expect(200);
    expect(agents.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: support.userId })]),
    );
    expect(agents.body[0]).not.toHaveProperty('email');
  });

  it('terminates only a support user session set with a reason and records the action', async () => {
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });

    await support.agent
      .post(`${API_PREFIX}/callcenter/users/${student.userId}/terminate-sessions`)
      .send({ reason: 'no' })
      .expect(400);
    await support.agent
      .post(`${API_PREFIX}/callcenter/users/${admin.userId}/terminate-sessions`)
      .send({ reason: 'Verified account recovery request' })
      .expect(404);
    const response = await support.agent
      .post(`${API_PREFIX}/callcenter/users/${student.userId}/terminate-sessions`)
      .send({ reason: 'Verified account recovery request' })
      .expect(201);
    expect(response.body.terminated).toBeGreaterThanOrEqual(1);

    const sessions = await ctx.dataSource.query('SELECT id FROM user_sessions WHERE user_id = $1', [
      student.userId,
    ]);
    expect(sessions).toHaveLength(0);
    const audit = await ctx.dataSource.query(
      'SELECT action, details FROM audit_logs WHERE target_id = $1',
      [student.userId],
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'support_user_sessions_terminated' }),
      ]),
    );
  });
});
