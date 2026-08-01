import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

function employeePayload(suffix: string): Record<string, string> {
  return {
    username: `support_${suffix}`,
    name: `Support ${suffix}`,
    email: `support_${suffix}@example.com`,
    phone: `010${suffix.slice(0, 8).padEnd(8, '0')}`,
    password: 'SupportPass123!',
  };
}

describe('Call Center Phase 1 access and role provisioning (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('allows only an admin to create a Call Center employee and writes an audit record', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const callCenter = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'call_center',
    });
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const payload = employeePayload('12345678');

    await request(server).post(`${API_PREFIX}/users/call-center`).send(payload).expect(401);
    await student.agent.post(`${API_PREFIX}/users/call-center`).send(payload).expect(403);
    await teacher.agent.post(`${API_PREFIX}/users/call-center`).send(payload).expect(403);
    await callCenter.agent.post(`${API_PREFIX}/users/call-center`).send(payload).expect(403);

    const created = await admin.agent
      .post(`${API_PREFIX}/users/call-center`)
      .send(payload)
      .expect(201);

    expect(created.body.user).toMatchObject({
      username: payload.username,
      email: payload.email,
      role: 'call_center',
    });
    expect(JSON.stringify(created.body)).not.toContain(payload.password);

    const auditRows = (await ctx.dataSource.query(
      "SELECT action, target_id, details FROM audit_logs WHERE action = 'call_center_employee_created'",
    )) as Array<{ action: string; target_id: string; details: { userRole: string } }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'call_center_employee_created',
      target_id: created.body.user.id,
      details: { userRole: 'call_center' },
    });
  });

  it('allows only an admin to assign CALL_CENTER, rejects role mass assignment, and audits it', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const callCenter = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'call_center',
    });
    const target = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    await callCenter.agent
      .patch(`${API_PREFIX}/users/${callCenter.userId}/call-center-role`)
      .send({ reason: 'self promotion' })
      .expect(403);
    await callCenter.agent
      .patch(`${API_PREFIX}/users/${target.userId}/call-center-role`)
      .send({ reason: 'promote another user' })
      .expect(403);

    // Both generic user-update endpoints reject a manually injected role field.
    await callCenter.agent.put(`${API_PREFIX}/users/me`).send({ role: 'call_center' }).expect(400);
    await admin.agent
      .put(`${API_PREFIX}/users/${target.userId}`)
      .send({ role: 'call_center' })
      .expect(400);

    // The dedicated endpoint rejects a caller-supplied role as well; the server
    // owns the fixed CALL_CENTER value.
    await admin.agent
      .patch(`${API_PREFIX}/users/${target.userId}/call-center-role`)
      .send({ role: 'call_center' })
      .expect(400);

    const changed = await admin.agent
      .patch(`${API_PREFIX}/users/${target.userId}/call-center-role`)
      .send({ reason: 'Approved support staffing' })
      .expect(200);
    expect(changed.body.user).toMatchObject({ id: target.userId, role: 'call_center' });

    const roles = (await ctx.dataSource.query('SELECT role FROM users WHERE id = $1', [
      target.userId,
    ])) as Array<{ role: string }>;
    expect(roles[0]?.role).toBe('call_center');

    const auditRows = (await ctx.dataSource.query(
      "SELECT action, target_id, details FROM audit_logs WHERE action = 'call_center_role_assigned'",
    )) as Array<{
      action: string;
      target_id: string;
      details: { previousRole: string; newRole: string };
    }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'call_center_role_assigned',
      target_id: target.userId,
      details: { previousRole: 'student', newRole: 'call_center' },
    });
  });

  it('keeps CALL_CENTER out of public registration and all non-admin role assignment APIs', async () => {
    const payload = {
      name: 'Invalid Call Center Request',
      email: 'invalid-call-center@example.com',
      password: 'ValidPassword123!',
      phone: '01012345678',
      requestedRole: 'call_center',
    };

    await request(server).post(`${API_PREFIX}/auth/register`).send(payload).expect(400);
  });

  it('keeps Admin APIs and the legacy Admin Call Center surface Admin-only', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const callCenter = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'call_center',
    });

    await admin.agent.get(`${API_PREFIX}/admin/students`).expect(200);
    await student.agent.get(`${API_PREFIX}/admin/students`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/admin/students`).expect(403);
    await callCenter.agent.get(`${API_PREFIX}/admin/students`).expect(403);
    await callCenter.agent.get(`${API_PREFIX}/callcenter/students`).expect(403);
    await admin.agent.get(`${API_PREFIX}/callcenter/students`).expect(200);
  });
});
