import type { Server } from 'node:http';
import request from 'supertest';

import { AuditLog } from '../../src/activity-logs/entities/audit-log.entity';
import { SupportCannedResponse } from '../../src/complaints/entities/support-canned-response.entity';
import { SupportKnowledgeArticle } from '../../src/complaints/entities/support-knowledge-article.entity';
import { SupportSlaPolicy } from '../../src/complaints/entities/support-sla-policy.entity';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

describe('Call Center Phase 8 reports and support resources (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;
  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('allows CALL_CENTER to read reports, SLA, approved responses and published knowledge only', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    await admin.agent
      .put(`${API_PREFIX}/admin/call-center/sla-policy`)
      .send({ first_response_hours: 12, resolution_hours: 48, warning_window_hours: 2 })
      .expect(200);
    await admin.agent
      .post(`${API_PREFIX}/admin/call-center/canned-responses`)
      .send({ title: 'Approved reply', body: 'We will help you shortly.' })
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/admin/call-center/knowledge-base`)
      .send({ title: 'Published article', body: 'Helpful guidance.', is_published: true })
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/admin/call-center/knowledge-base`)
      .send({ title: 'Draft article', body: 'Not visible.', is_published: false })
      .expect(201);

    await request(server).get(`${API_PREFIX}/callcenter/reports`).expect(401);
    await student.agent.get(`${API_PREFIX}/callcenter/reports`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/callcenter/sla`).expect(403);
    const report = await support.agent.get(`${API_PREFIX}/callcenter/reports`).expect(200);
    expect(report.body).toHaveProperty('delayed');
    const sla = await support.agent.get(`${API_PREFIX}/callcenter/sla`).expect(200);
    expect(sla.body.policy).toMatchObject({
      first_response_hours: 12,
      resolution_hours: 48,
      warning_window_hours: 2,
    });
    const canned = await support.agent
      .get(`${API_PREFIX}/callcenter/resources/canned-responses`)
      .query({ search: 'Approved' })
      .expect(200);
    expect(canned.body.data).toHaveLength(1);
    const articles = await support.agent
      .get(`${API_PREFIX}/callcenter/resources/knowledge-base`)
      .expect(200);
    expect(articles.body.data).toHaveLength(1);
    expect(articles.body.data[0].title).toBe('Published article');
  });

  it('keeps management APIs Admin-only, audits their mutations, and leaves executive finance unavailable', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const policy = { first_response_hours: 24, resolution_hours: 72, warning_window_hours: 4 };
    await support.agent.put(`${API_PREFIX}/admin/call-center/sla-policy`).send(policy).expect(403);
    await support.agent
      .post(`${API_PREFIX}/admin/call-center/canned-responses`)
      .send({ title: 'No', body: 'No' })
      .expect(403);
    await support.agent
      .post(`${API_PREFIX}/admin/call-center/knowledge-base`)
      .send({ title: 'No', body: 'No', is_published: true })
      .expect(403);
    await support.agent.post(`${API_PREFIX}/admin/finance/refunds`).send({}).expect(403);
    await admin.agent.put(`${API_PREFIX}/admin/call-center/sla-policy`).send(policy).expect(200);
    const response = await admin.agent
      .post(`${API_PREFIX}/admin/call-center/canned-responses`)
      .send({ title: 'Admin response', body: '<script>blocked</script>Reply' })
      .expect(201);
    const article = await admin.agent
      .post(`${API_PREFIX}/admin/call-center/knowledge-base`)
      .send({ title: 'Admin article', body: 'Guidance', is_published: true })
      .expect(201);
    await admin.agent
      .delete(`${API_PREFIX}/admin/call-center/canned-responses/${response.body.id}`)
      .expect(200);
    await admin.agent
      .delete(`${API_PREFIX}/admin/call-center/knowledge-base/${article.body.id}`)
      .expect(200);
    await admin.agent.delete(`${API_PREFIX}/admin/call-center/sla-policy`).expect(200);
    expect(await ctx.dataSource.getRepository(SupportSlaPolicy).count()).toBe(1);
    expect(
      await ctx.dataSource.getRepository(SupportCannedResponse).count({ withDeleted: true }),
    ).toBe(1);
    expect(
      await ctx.dataSource.getRepository(SupportKnowledgeArticle).count({ withDeleted: true }),
    ).toBe(1);
    const actions = (
      await ctx.dataSource.getRepository(AuditLog).find({ where: { admin_id: admin.userId } })
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'support_sla_policy_created',
        'support_canned_response_created',
        'support_canned_response_deleted',
        'support_knowledge_article_created',
        'support_knowledge_article_deleted',
        'support_sla_policy_deleted',
      ]),
    );
    expect(response.body.body).not.toContain('<script>');
  });
});
