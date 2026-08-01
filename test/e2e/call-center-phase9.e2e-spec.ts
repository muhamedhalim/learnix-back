import type { Server } from 'node:http';
import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

describe('Call Center Phase 9 security hardening (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('allowlists resource output and bounds untrusted list input', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    await admin.agent
      .post(`${API_PREFIX}/admin/call-center/canned-responses`)
      .send({ title: 'Safe reply', body: 'Approved response' })
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/admin/call-center/knowledge-base`)
      .send({ title: 'Safe knowledge', body: 'Published article', is_published: true })
      .expect(201);

    const canned = await support.agent
      .get(`${API_PREFIX}/callcenter/resources/canned-responses`)
      .query({ limit: 100 })
      .expect(200);
    expect(canned.body.data[0]).toEqual(
      expect.objectContaining({ title: 'Safe reply', body: 'Approved response' }),
    );
    for (const key of ['created_by', 'updated_by', 'deleted_at']) {
      expect(canned.body.data[0]).not.toHaveProperty(key);
    }
    const articles = await support.agent
      .get(`${API_PREFIX}/callcenter/resources/knowledge-base`)
      .expect(200);
    for (const key of ['created_by', 'updated_by', 'deleted_at']) {
      expect(articles.body.data[0]).not.toHaveProperty(key);
    }
    await support.agent
      .get(`${API_PREFIX}/callcenter/resources/canned-responses`)
      .query({ limit: 101 })
      .expect(400);
    await support.agent
      .get(`${API_PREFIX}/callcenter/resources/canned-responses`)
      .query({ is_active: false })
      .expect(400);
  });

  it('rejects direct management API abuse before service execution', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const payload = { title: 'Managed response', body: 'Approved', created_by: support.userId };

    await request(server)
      .post(`${API_PREFIX}/admin/call-center/canned-responses`)
      .send(payload)
      .expect(401);
    await support.agent
      .post(`${API_PREFIX}/admin/call-center/canned-responses`)
      .send(payload)
      .expect(403);
    await student.agent
      .put(`${API_PREFIX}/admin/call-center/sla-policy`)
      .send({ first_response_hours: 1, resolution_hours: 1, warning_window_hours: 1 })
      .expect(403);
    await teacher.agent
      .post(`${API_PREFIX}/admin/call-center/knowledge-base`)
      .send({ title: 'No', body: 'No', is_published: true })
      .expect(403);
    await admin.agent
      .post(`${API_PREFIX}/admin/call-center/canned-responses`)
      .send(payload)
      .expect(400);
    await admin.agent
      .put(`${API_PREFIX}/admin/call-center/canned-responses/not-a-uuid`)
      .send({ title: 'No', body: 'No' })
      .expect(400);
  });
});
