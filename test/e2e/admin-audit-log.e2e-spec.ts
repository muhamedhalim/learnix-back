import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T112 / W7-C3: the teacher-detail Audit tab filters `GET /admin/audit-log` by
 * `target_id` on the server. 120 newer rows for other users must not push the
 * teacher's three rows out of the result.
 */
describe('admin audit log target_id filter (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function insertLog(
    adminId: string,
    targetId: string,
    createdAt: Date,
    targetType = 'user',
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, target_name, created_at)
       VALUES ($1, $2, 'user_approved', $3, $4, 'Target', $5)`,
      [randomUUID(), adminId, targetType, targetId, createdAt],
    );
  }

  it('returns exactly the rows for target_id, newest first, with a trimmed admin projection', async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const teacherId = randomUUID();
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 3; i += 1) {
      await insertLog(admin.userId, teacherId, new Date(base + i * 1000));
    }
    // 120 newer rows for other users
    for (let i = 0; i < 120; i += 1) {
      await insertLog(admin.userId, randomUUID(), new Date(base + 10_000 + i * 1000));
    }

    const res = await admin.agent
      .get(`${API_PREFIX}/admin/audit-log`)
      .query({ target_type: 'user', target_id: teacherId, page: 1, limit: 20 })
      .expect(200);
    const body = res.body as {
      data: Array<{ target_id: string; created_at: string; admin: Record<string, unknown> }>;
      meta: { total: number };
    };
    expect(body.meta.total).toBe(3);
    expect(body.data).toHaveLength(3);
    expect(body.data.every((r) => r.target_id === teacherId)).toBe(true);
    const times = body.data.map((r) => new Date(r.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    for (const row of body.data) {
      expect(Object.keys(row.admin).sort()).toEqual(['email', 'id', 'name']);
    }
  });

  it('paginates server-side for the filtered target', async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const teacherId = randomUUID();
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 25; i += 1) {
      await insertLog(admin.userId, teacherId, new Date(base + i * 1000));
    }
    const res = await admin.agent
      .get(`${API_PREFIX}/admin/audit-log`)
      .query({ target_id: teacherId, page: 2, limit: 20 })
      .expect(200);
    const body = res.body as { data: unknown[]; meta: { total: number; page: number } };
    expect(body.meta.total).toBe(25);
    expect(body.meta.page).toBe(2);
    expect(body.data).toHaveLength(5);
  });

  it('rejects a malformed target_id and non-admins, and leaves the unfiltered list working', async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await admin.agent
      .get(`${API_PREFIX}/admin/audit-log`)
      .query({ target_id: 'not-a-uuid' })
      .expect(400);

    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    await teacher.agent.get(`${API_PREFIX}/admin/audit-log`).expect(403);

    await insertLog(admin.userId, randomUUID(), new Date());
    const all = await admin.agent.get(`${API_PREFIX}/admin/audit-log`).expect(200);
    expect((all.body as { meta: { total: number } }).meta.total).toBe(1);
  });
});
