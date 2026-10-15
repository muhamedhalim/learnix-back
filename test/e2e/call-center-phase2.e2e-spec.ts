import { Readable } from 'node:stream';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';
import { StorageService } from '../../src/storage/storage.service';
import { Complaint } from '../../src/complaints/entities/complaint.entity';

const ticketPayload = {
  type: 'technical',
  subject: 'Unable to watch recorded lesson',
  description: 'The recorded lesson fails to load after signing in.',
};

describe('Call Center Phase 2 ticket foundation (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    const objects = new Map<string, { buffer: Buffer; contentType: string }>();
    const storage: Partial<StorageService> = {
      upload: async ({ buffer, path, contentType, visibility = 'public' }) => {
        objects.set(path, { buffer, contentType });
        return { url: '', path, size: buffer.length, visibility };
      },
      getObject: async (path) => {
        const object = objects.get(path);
        if (!object) throw new Error('Object not found');
        return {
          stream: Readable.from(object.buffer),
          contentType: object.contentType,
          contentLength: object.buffer.length,
        };
      },
      tryDelete: async (path) => {
        objects.delete(path);
      },
    };
    ctx = await createE2EApp({ storageService: storage });
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('creates canonical student tickets, enforces object ownership, and hides internal notes', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const otherStudent = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });

    const created = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(ticketPayload)
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'new',
      complainant_id: student.userId,
      complainant_role: 'student',
      version: 1,
    });
    expect(created.body.ticket_number).toMatch(/^CC-\d{4}-.+$/);

    await otherStudent.agent.get(`${API_PREFIX}/student/complaints/${created.body.id}`).expect(404);
    await student.agent.get(`${API_PREFIX}/callcenter/tickets`).expect(403);
    await support.agent.get(`${API_PREFIX}/callcenter/tickets/${created.body.id}`).expect(200);
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/assignment`)
      .send({ agent_id: support.userId, version: created.body.version })
      .expect(200);

    await support.agent
      .post(`${API_PREFIX}/callcenter/tickets/${created.body.id}/messages`)
      .send({ body: '<script>alert(1)</script>Internal diagnosis', internal: true })
      .expect(201);
    await support.agent
      .post(`${API_PREFIX}/callcenter/tickets/${created.body.id}/messages`)
      .send({ body: 'We are investigating your request.', internal: false })
      .expect(201);

    const detail = await student.agent
      .get(`${API_PREFIX}/student/complaints/${created.body.id}`)
      .expect(200);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].kind).toBe('agent_reply');
    expect(detail.body.messages[0].body).not.toContain('<script>');
  });

  it('deduplicates retried complaint creation and validates complaint targets', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const requestId = '3c5bb8e0-8a3e-4a4d-97ab-84482590b824';
    const payload = { ...ticketPayload, request_id: requestId };

    const first = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(payload)
      .expect(201);
    const retry = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(payload)
      .expect(201);

    expect(retry.body.id).toBe(first.body.id);
    expect(await ctx.dataSource.getRepository(Complaint).count()).toBe(1);
    await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send({ ...ticketPayload, target_id: student.userId })
      .expect(400);
    await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send({ ...ticketPayload, subject: '   ' })
      .expect(400);
  });

  it('enforces optimistic lifecycle transitions, valid support assignment, and audit history', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const otherSupport = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'call_center',
    });
    const nonSupport = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const created = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(ticketPayload)
      .expect(201);

    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/assignment`)
      .send({ agent_id: nonSupport.userId, version: 1 })
      .expect(400);
    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/assignment`)
      .send({ agent_id: otherSupport.userId, version: 1 })
      .expect(403);
    const assigned = await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${created.body.id}/assignment`)
      .send({ agent_id: support.userId, version: 1 })
      .expect(200);
    expect(assigned.body).toMatchObject({ assigned_agent_id: support.userId, version: 2 });
    await otherSupport.agent.get(`${API_PREFIX}/callcenter/tickets/${created.body.id}`).expect(403);

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
      'SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY created_at ASC',
      [created.body.id],
    )) as Array<{ action: string }>;
    expect(auditRows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'support_ticket_created',
        'support_ticket_assigned',
        'support_ticket_status_changed',
      ]),
    );
  });

  it('keeps existing Admin complaint response behavior and allows teachers to own only their tickets', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const studentTicket = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(ticketPayload)
      .expect(201);
    const teacherTicket = await teacher.agent
      .post(`${API_PREFIX}/teacher/complaints`)
      .send(ticketPayload)
      .expect(201);

    const agents = await admin.agent.get(`${API_PREFIX}/callcenter/agents`).expect(200);
    expect(agents.body).toHaveLength(1);
    await admin.agent.get(`${API_PREFIX}/callcenter/tickets/${teacherTicket.body.id}`).expect(200);

    await student.agent
      .get(`${API_PREFIX}/teacher/complaints/${teacherTicket.body.id}`)
      .expect(403);
    await teacher.agent
      .get(`${API_PREFIX}/teacher/complaints/${studentTicket.body.id}`)
      .expect(404);
    const responded = await admin.agent
      .post(`${API_PREFIX}/admin/complaints/${studentTicket.body.id}/respond`)
      .send({ admin_response: 'This has been fixed.', version: studentTicket.body.version })
      .expect(201);
    expect(responded.body.status).toBe('resolved');
    expect(responded.body.resolution).toBe('This has been fixed.');
    expect(responded.body.version).toBe(studentTicket.body.version + 1);
  });

  it('keeps Call Center ticket attachments private, ticket-scoped, and auditable', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const otherStudent = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const ticket = await student.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(ticketPayload)
      .expect(201);
    const otherTicket = await otherStudent.agent
      .post(`${API_PREFIX}/student/complaints`)
      .send(ticketPayload)
      .expect(201);

    await student.agent
      .post(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/attachments`)
      .attach('file', Buffer.from('%PDF-1.4\nprivate support evidence\n'), 'evidence.pdf')
      .expect(403);

    await support.agent
      .patch(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/assignment`)
      .send({ agent_id: support.userId, version: ticket.body.version })
      .expect(200);

    const uploaded = await support.agent
      .post(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}/attachments`)
      .attach('file', Buffer.from('%PDF-1.4\nprivate support evidence\n'), 'evidence.pdf')
      .expect(201);
    expect(uploaded.body).toMatchObject({
      original_filename: 'evidence.pdf',
      mime_type: 'application/pdf',
    });
    expect(uploaded.body).not.toHaveProperty('storage_key');

    const detail = await support.agent
      .get(`${API_PREFIX}/callcenter/tickets/${ticket.body.id}`)
      .expect(200);
    expect(detail.body.attachments).toHaveLength(1);
    expect(detail.body.attachments[0]).not.toHaveProperty('storage_key');
    await student.agent
      .get(
        `${API_PREFIX}/callcenter/tickets/${ticket.body.id}/attachments/${uploaded.body.id}/download`,
      )
      .expect(403);
    await support.agent
      .get(
        `${API_PREFIX}/callcenter/tickets/${otherTicket.body.id}/attachments/${uploaded.body.id}/download`,
      )
      .expect(403);
    await support.agent
      .get(
        `${API_PREFIX}/callcenter/tickets/${ticket.body.id}/attachments/${uploaded.body.id}/download`,
      )
      .expect('Cache-Control', 'private, no-store')
      .expect(200);

    const auditRows = (await ctx.dataSource.query(
      'SELECT action FROM audit_logs WHERE target_id = $1',
      [ticket.body.id],
    )) as Array<{ action: string }>;
    expect(auditRows.map((row) => row.action)).toContain('support_ticket_attachment_added');
  });
});
