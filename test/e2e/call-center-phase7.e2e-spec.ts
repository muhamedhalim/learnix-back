import type { Server } from 'node:http';

import request from 'supertest';

import { SupportSlaService } from '../../src/complaints/support-sla.service';
import { Complaint } from '../../src/complaints/entities/complaint.entity';
import { Notification } from '../../src/notifications/entities';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

const ticketPayload = {
  type: 'technical',
  subject: 'Need help with a recorded lesson',
  description: 'The recorded lesson cannot be opened after a successful sign in.',
};

describe('Call Center Phase 7 notifications and SLA (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;
  let sla: SupportSlaService;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
    sla = ctx.app.get(SupportSlaService);
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('dispatches idempotent in-app notifications for the canonical ticket lifecycle', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const ticket = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(ticketPayload)
      .expect(201);

    expect(ticket.body.first_response_due_at).toBeTruthy();
    expect(ticket.body.resolution_due_at).toBeTruthy();
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/assignment`)
      .send({ agent_id: support.userId, version: ticket.body.version })
      .expect(200);
    await support.agent
      .post(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/messages`)
      .send({ body: 'We are checking this for you.', internal: false })
      .expect(201);
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/status`)
      .send({ status: 'in_progress', version: 3 })
      .expect(200);
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/status`)
      .send({ status: 'waiting_for_user', version: 4 })
      .expect(200);

    const rows = await ctx.dataSource.getRepository(Notification).find({
      where: {},
      order: { sent_at: 'ASC' },
    });
    expect(rows.map((row) => row.data?.support_ticket?.event)).toEqual(
      expect.arrayContaining(['created', 'assigned', 'agent_reply', 'waiting_for_user']),
    );
    expect(rows.every((row) => row.sms_sent === false)).toBe(true);
    expect(rows.every((row) => row.status === 'sent')).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it('evaluates SLA alerts once, exposes only dispatch status, and denies other roles', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const ticket = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(ticketPayload)
      .expect(201);
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/assignment`)
      .send({ agent_id: support.userId, version: ticket.body.version })
      .expect(200);
    const now = new Date();
    await ctx.dataSource.getRepository(Complaint).update(ticket.body.id, {
      first_response_due_at: new Date(now.getTime() - 1_000),
      resolution_due_at: new Date(now.getTime() + 60 * 60 * 1_000),
    });

    await sla.evaluate();
    await sla.evaluate();

    await request(server).get(`${API_PREFIX}/callcenter/notifications`).expect(401);
    await student.agent.get(`${API_PREFIX}/callcenter/notifications`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/callcenter/notifications`).expect(403);
    await admin.agent.get(`${API_PREFIX}/callcenter/notifications`).expect(403);
    const response = await support.agent
      .get(`${API_PREFIX}/callcenter/notifications`)
      .query({ search: ticket.body.ticket_number })
      .expect(200);
    expect(response.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticket_number: ticket.body.ticket_number,
          event: 'sla_first_response_exceeded',
          status: 'sent',
        }),
      ]),
    );
    expect(response.body.data[0]).not.toHaveProperty('message');
    expect(response.body.data[0]).not.toHaveProperty('user_id');
    expect(response.body.data[0]).not.toHaveProperty('sms_to');
    expect(response.body.data[0]).not.toHaveProperty('error_message');
    const alerts = await ctx.dataSource.query(
      `SELECT count(*)::int AS count FROM notifications WHERE dedupe_key LIKE 'support-ticket:%:sla_first_response_exceeded:%'`,
    );
    expect(alerts[0].count).toBe(1);
  });
});
