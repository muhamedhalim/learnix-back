import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

const ticketPayload = {
  type: 'technical',
  subject: 'Unable to watch recorded lesson',
  description: 'The recorded lesson fails to load after signing in.',
};

describe('Call Center Phase 2 ticket foundation (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('creates canonical student tickets, enforces object ownership, and hides internal notes', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const otherStudent = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });

    const created = await student.agent.post(`${API_PREFIX}/student/complaints`).send(ticketPayload).expect(201);
    expect(created.body).toMatchObject({
      status: 'new', complainant_id: student.userId, complainant_role: 'student', version: 1,
    });
    expect(created.body.ticket_number).toMatch(/^CC-\d{4}-.+$/);

    await otherStudent.agent.get(`${API_PREFIX}/student/complaints/${created.body.id}`).expect(404);
    await student.agent.get(`${API_PREFIX}/callcenter/tickets`).expect(403);
    await support.agent.get(`${API_PREFIX}/callcenter/tickets/${created.body.id}`).expect(200);

    await support.agent
      .post(`${API_PREFIX}/callcenter/tickets/${created.body.id}/messages`)
      .send({ body: '<script>alert(1)</script>Internal diagnosis', internal: true })
      .expect(201);
    await support.agent
      .post(`${API_PREFIX}/callcenter/tickets/${created.body.id}/messages`)
      .send({ body: 'We are investigating your request.', internal: false })
      .expect(201);

    const detail = await student.agent.get(`${API_PREFIX}/student/complaints/${created.body.id}`).expect(200);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].kind).toBe('agent_reply');
    expect(detail.body.messages[0].body).not.toContain('<script>');
  });

  it('enforces optimistic lifecycle transitions, valid support assignment, and audit history', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const nonSupport = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const created = await student.agent.post(`${API_PREFIX}/student/complaints`).send(ticketPayload).expect(201);

    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/assignment`)
      .send({ agent_id: nonSupport.userId, version: 1 })
      .expect(400);
    const assigned = await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/assignment`)
      .send({ agent_id: support.userId, version: 1 })
      .expect(200);
    expect(assigned.body).toMatchObject({ assigned_agent_id: support.userId, version: 2 });

    const transitioned = await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/status`)
      .send({ status: 'in_progress', version: 2 })
      .expect(200);
    expect(transitioned.body).toMatchObject({ status: 'in_progress', version: 3 });
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/status`)
      .send({ status: 'waiting_for_user', version: 2 })
      .expect(409);
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/status`)
      .send({ status: 'closed', version: 3 })
      .expect(400);

    const auditRows = (await ctx.dataSource.query(
      "SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY created_at ASC", [created.body.id],
    )) as Array<{ action: string }>;
    expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining([
      'support_ticket_created', 'support_ticket_assigned', 'support_ticket_status_changed',
    ]));
  });

  it('keeps existing Admin complaint response behavior and allows teachers to own only their tickets', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const studentTicket = await student.agent.post(`${API_PREFIX}/student/complaints`).send(ticketPayload).expect(201);
    const teacherTicket = await teacher.agent.post(`${API_PREFIX}/teacher/complaints`).send(ticketPayload).expect(201);

    await student.agent.get(`${API_PREFIX}/teacher/complaints/${teacherTicket.body.id}`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/teacher/complaints/${studentTicket.body.id}`).expect(404);
    const responded = await admin.agent
      .post(`${API_PREFIX}/admin/complaints/${studentTicket.body.id}/respond`)
      .send({ admin_response: 'This has been fixed.' })
      .expect(201);
    expect(responded.body.status).toBe('resolved');
  });
});
