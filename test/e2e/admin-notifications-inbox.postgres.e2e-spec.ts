import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { HealthAlertService } from '../../src/health/health-alert.service';
import { HealthIncidentService } from '../../src/health/health-incident.service';
import { HealthAlertRule, HealthMetric } from '../../src/health/entities';
import type { HealthComponentResult } from '../../src/health/health.types';
import { OperationalAlertService } from '../../src/health/operational-alert.service';
import { seedHealthAlertRules } from '../../src/database/system-seed';
import { RemoveTechnicalAdminNotifications2208000000000 } from '../../src/migrations/2208000000000-RemoveTechnicalAdminNotifications';
import {
  AdminNotificationCategory,
  Notification,
  NotificationOrigin,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
} from '../../src/notifications/entities';
import { AdminNotificationEvent } from '../../src/notifications/constants/admin-notification-events';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
} from './fixtures';

/**
 * Admin personal inbox (`/admin/my-notifications` → `GET /notifications`):
 * only business notifications may appear — technical monitoring alerts such as
 * "[WARNING][production] Component becomes degraded" must not, and must not be
 * created again. Real PostgreSQL, real Nest app, real guards and services.
 */
describe('Admin notification inbox is business-only (postgres)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let seq = 0;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });
  beforeEach(async () => {
    await resetDatabase(dataSource);
    await dataSource.query('DROP TABLE IF EXISTS "notifications_technical_alert_archive"');
  });
  afterAll(async () => app.close());

  async function insert(
    userId: string,
    overrides: Partial<Notification> & { title: string },
  ): Promise<string> {
    seq += 1;
    const repo = dataSource.getRepository(Notification);
    const saved = await repo.save(
      repo.create({
        user_id: userId,
        type: NotificationType.CUSTOM,
        message: `message ${String(seq)}`,
        data: null,
        priority: null,
        category: null,
        link: null,
        origin: NotificationOrigin.SYSTEM,
        source_event: null,
        is_read: false,
        sent_at: new Date(Date.now() - seq * 1_000),
        status: NotificationStatus.SENT,
        attempts: 0,
        dedupe_key: null,
        ...overrides,
      }),
    );
    return saved.id;
  }

  const business = (userId: string, event: AdminNotificationEvent, title: string) =>
    insert(userId, {
      title,
      origin: NotificationOrigin.OPERATIONAL,
      source_event: event,
      priority: NotificationPriority.HIGH,
      category: AdminNotificationCategory.FINANCIAL,
      link: '/admin/payments',
    });

  async function seedInbox(
    adminId: string,
  ): Promise<{ businessIds: string[]; technicalIds: string[] }> {
    const businessIds = [
      await business(adminId, AdminNotificationEvent.PURCHASE_COMPLETED, 'Payment completed'),
      await business(
        adminId,
        AdminNotificationEvent.MANUAL_PAYMENT_REVIEW_REQUIRED,
        'New manual payment proof',
      ),
      await business(
        adminId,
        AdminNotificationEvent.TEACHER_REGISTRATION_PENDING,
        'New instructor registration request',
      ),
      await business(
        adminId,
        AdminNotificationEvent.COURSE_PUBLISHED_FOR_REVIEW,
        'Course ready for review',
      ),
      await business(
        adminId,
        AdminNotificationEvent.MARKETPLACE_REFUND_REQUESTED,
        'Refund requested',
      ),
      // Business incident raised through OperationalAlertService.
      await insert(adminId, {
        title: '[CRITICAL][production] Payment quarantined during reconciliation',
        origin: NotificationOrigin.OPERATIONAL,
        source_event: AdminNotificationEvent.OPERATIONAL_ALERT,
        category: AdminNotificationCategory.FINANCIAL,
        priority: NotificationPriority.CRITICAL,
      }),
      // Pre-catalog row: the raw alert key was stored as source_event.
      await insert(adminId, {
        title: '[CRITICAL][production] Payment webhook dead-lettered',
        origin: NotificationOrigin.OPERATIONAL,
        source_event: 'payment.webhook_dead_letter:evt-1',
      }),
    ];
    const technicalIds = [
      await insert(adminId, {
        title: '[WARNING][production] Component becomes degraded',
        origin: NotificationOrigin.OPERATIONAL,
        source_event: AdminNotificationEvent.OPERATIONAL_ALERT,
        category: AdminNotificationCategory.SYSTEM,
        priority: NotificationPriority.HIGH,
        link: '/admin/health',
        data: { alertKey: 'health-rule:component-degraded:postgresql', severity: 'warning' },
      }),
      await insert(adminId, {
        title: '[WARNING][production] Component becomes degraded',
        origin: NotificationOrigin.OPERATIONAL,
        source_event: 'health-rule:component-degraded:redis',
      }),
      await insert(adminId, {
        title: '[CRITICAL][production] Scheduled job "cleanup" is failing repeatedly',
        origin: NotificationOrigin.OPERATIONAL,
        source_event: 'scheduled_job.repeated_failure:cleanup',
      }),
      await insert(adminId, {
        title: '[WARNING][production] Queue backlog exceeds threshold',
        origin: NotificationOrigin.OPERATIONAL,
        source_event: 'queue.backlog:mail',
      }),
      // Not an admin event at all (would have leaked before the allow-list).
      await insert(adminId, { title: 'Homework graded', type: NotificationType.HOMEWORK }),
    ];
    return { businessIds, technicalIds };
  }

  async function listIds(
    agent: AuthenticatedUser['agent'],
    query = 'limit=100',
  ): Promise<{ ids: string[]; meta: Record<string, number | boolean>; titles: string[] }> {
    const res = await agent.get(`${API_PREFIX}/notifications?${query}`).expect(200);
    const rows = (res.body.data ?? []) as Array<{ id: string; title: string }>;
    return {
      ids: rows.map((row) => row.id),
      titles: rows.map((row) => row.title),
      meta: res.body.meta as Record<string, number | boolean>,
    };
  }

  describe('GET /notifications as an admin', () => {
    it('returns the business notifications and omits every technical monitoring alert', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const { businessIds, technicalIds } = await seedInbox(admin.userId);

      const { ids, titles, meta } = await listIds(admin.agent);

      expect([...ids].sort()).toEqual([...businessIds].sort());
      for (const technicalId of technicalIds) expect(ids).not.toContain(technicalId);
      expect(titles.join('\n')).not.toMatch(/Component becomes degraded/);
      expect(meta['total']).toBe(businessIds.length);
    });

    it('keeps pagination totals consistent with the eligible rows only', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const { businessIds } = await seedInbox(admin.userId);

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const { ids, meta } = await listIds(admin.agent, `limit=3&page=${String(page)}`);
        expect(meta['total']).toBe(businessIds.length);
        expect(meta['totalPages']).toBe(3);
        expect(meta['hasNextPage']).toBe(page < 3);
        seen.push(...ids);
      }
      expect([...seen].sort()).toEqual([...businessIds].sort());
      expect((await listIds(admin.agent, 'limit=3&page=4')).ids).toEqual([]);
    });

    it('excludes technical alerts from the unread badge and the unread filter', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const { businessIds } = await seedInbox(admin.userId);

      const count = await admin.agent.get(`${API_PREFIX}/notifications/unread/count`).expect(200);
      expect(count.body.data.count).toBe(businessIds.length);

      const unread = await listIds(admin.agent, 'is_read=false&limit=100');
      expect(unread.meta['total']).toBe(businessIds.length);
    });

    it('still supports read / unread transitions and the priority filter', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const { businessIds } = await seedInbox(admin.userId);

      await admin.agent.post(`${API_PREFIX}/notifications/${businessIds[0]!}/read`).expect(201);
      const count = await admin.agent.get(`${API_PREFIX}/notifications/unread/count`).expect(200);
      expect(count.body.data.count).toBe(businessIds.length - 1);

      const unread = await listIds(admin.agent, 'is_read=false&limit=100');
      expect(unread.ids).not.toContain(businessIds[0]);
      expect(unread.meta['total']).toBe(businessIds.length - 1);

      const critical = await listIds(admin.agent, 'priority=critical&limit=100');
      expect(critical.titles).toEqual([
        '[CRITICAL][production] Payment quarantined during reconciliation',
      ]);
    });

    it("does not expose another admin's notifications, business or technical", async () => {
      const adminA = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const adminB = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const a = await seedInbox(adminA.userId);
      const b = await seedInbox(adminB.userId);

      const seenByA = (await listIds(adminA.agent)).ids;
      expect([...seenByA].sort()).toEqual([...a.businessIds].sort());
      for (const id of [...b.businessIds, ...b.technicalIds]) expect(seenByA).not.toContain(id);

      // And cannot mutate it either.
      await adminA.agent.post(`${API_PREFIX}/notifications/${b.businessIds[0]!}/read`).expect(404);
    });

    it('shows an empty list and zero badge when only technical alerts exist', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const { technicalIds } = await seedInbox(admin.userId);
      await dataSource
        .getRepository(Notification)
        .delete({ user_id: admin.userId, source_event: AdminNotificationEvent.PURCHASE_COMPLETED });
      await dataSource.query(
        `DELETE FROM "notifications" WHERE "user_id" = $1 AND "id" <> ALL($2::uuid[])`,
        [admin.userId, technicalIds],
      );

      const { ids, meta } = await listIds(admin.agent);
      expect(ids).toEqual([]);
      expect(meta['total']).toBe(0);
      const count = await admin.agent.get(`${API_PREFIX}/notifications/unread/count`).expect(200);
      expect(count.body.data.count).toBe(0);
    });
  });

  describe('access control', () => {
    it('rejects an unauthenticated caller', async () => {
      const server = app.getHttpServer() as Parameters<typeof request>[0];
      await request(server).get(`${API_PREFIX}/notifications`).expect(401);
      await request(server).get(`${API_PREFIX}/notifications/unread/count`).expect(401);
    });

    it('leaves a student inbox untouched by the admin rule and isolated from admin rows', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const student = await createAuthenticatedUser(app, dataSource);
      const adminRows = await seedInbox(admin.userId);
      const own = await insert(student.userId, {
        title: 'Homework graded',
        type: NotificationType.HOMEWORK,
      });

      const { ids } = await listIds(student.agent);
      expect(ids).toEqual([own]);
      for (const id of [...adminRows.businessIds, ...adminRows.technicalIds]) {
        expect(ids).not.toContain(id);
      }
    });
  });

  describe('technical alerts are not created again (producer boundary)', () => {
    function degraded(id: string): HealthComponentResult {
      return {
        id,
        name: id,
        category: 'database',
        status: 'degraded',
        latencyMs: 900,
        checkedAt: new Date().toISOString(),
        lastSuccessAt: null,
        failureCount: 1,
        availabilityPercent: 90,
        message: 'Connection pool saturated',
        metadata: {},
        warnings: [],
        errorCode: null,
        dependencies: [],
        recommendation: null,
      } as HealthComponentResult;
    }

    it('the seeded "Component becomes degraded" rule fires without creating any admin notification', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await seedHealthAlertRules(dataSource.manager);
      const rules = dataSource.getRepository(HealthAlertRule);
      await rules.update(
        { key: 'component-degraded' },
        { duration_seconds: 0, cooldown_seconds: 0 },
      );
      const alerts = app.get(HealthAlertService);

      await alerts.evaluate([degraded('postgresql')]);
      await alerts.evaluate([degraded('postgresql')]);

      // The rule engine did run (monitoring is alive)…
      const rule = await rules.findOneByOrFail({ key: 'component-degraded' });
      expect(rule.last_triggered_at).not.toBeNull();
      // …but nothing reached the inbox, in the table or through the API.
      expect(
        await dataSource.getRepository(Notification).count({ where: { user_id: admin.userId } }),
      ).toBe(0);
      expect((await listIds(admin.agent)).ids).toEqual([]);
    });

    it('a technical alert dispatched directly creates no notification, a business one reaches every active admin', async () => {
      const adminA = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const adminB = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const alerts = app.get(OperationalAlertService);

      const technical = await alerts.dispatch({
        key: 'health-rule:queue-backlog:queue-mail',
        audience: 'technical',
        severity: 'warning',
        title: 'Queue backlog exceeds threshold',
        message: 'Queue mail: backlog is 400.00 (threshold 250.00).',
      });
      expect(technical.inApp).toBe('skipped');
      expect(await dataSource.getRepository(Notification).count()).toBe(0);

      const businessOutcome = await alerts.dispatch({
        key: 'payment.reconciliation_alert:pay-1',
        audience: 'business',
        severity: 'critical',
        title: 'Payment quarantined during reconciliation',
        message: 'Manual financial review is required.',
      });
      expect(businessOutcome.inApp).toBe('sent');
      for (const admin of [adminA, adminB]) {
        const { titles } = await listIds(admin.agent);
        expect(titles).toEqual([
          expect.stringContaining('Payment quarantined during reconciliation'),
        ]);
      }
    });

    it('technical incidents stay available on the monitoring channel (/health)', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const student = await createAuthenticatedUser(app, dataSource);
      await seedHealthAlertRules(dataSource.manager);
      const now = Date.now();
      await dataSource.getRepository(HealthMetric).save(
        [1, 2].map((minutes) =>
          dataSource.getRepository(HealthMetric).create({
            component_id: 'postgresql',
            category: 'database',
            status: 'degraded',
            latency_ms: 900,
            resolution: 'raw',
            bucket_start: new Date(now - minutes * 60_000),
            sample_count: 1,
            metrics: {},
          }),
        ),
      );

      await app.get(HealthIncidentService).evaluate([degraded('postgresql')]);

      const incidents = await admin.agent.get(`${API_PREFIX}/health/incidents`).expect(200);
      const rows = (incidents.body.data ?? incidents.body) as Array<{ component_id: string }>;
      expect(rows.map((row) => row.component_id)).toContain('postgresql');
      const ruleList = await admin.agent.get(`${API_PREFIX}/health/alerts`).expect(200);
      expect(JSON.stringify(ruleList.body)).toContain('Component becomes degraded');
      await student.agent.get(`${API_PREFIX}/health/incidents`).expect(403);
    });
  });

  describe('cleanup migration 2208000000000', () => {
    const migration = new RemoveTechnicalAdminNotifications2208000000000();

    async function counts(): Promise<{ total: number; archived: number }> {
      const [{ n }] = (await dataSource.query(
        'SELECT count(*)::int AS n FROM "notifications"',
      )) as [{ n: number }];
      const archive = (await dataSource.query(
        `SELECT to_regclass('notifications_technical_alert_archive') AS t`,
      )) as [{ t: string | null }];
      if (archive[0].t === null) return { total: n, archived: 0 };
      const [{ a }] = (await dataSource.query(
        'SELECT count(*)::int AS a FROM "notifications_technical_alert_archive"',
      )) as [{ a: number }];
      return { total: n, archived: a };
    }

    it('removes only technical alerts, is repeatable, and can be reverted', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const student = await createAuthenticatedUser(app, dataSource);
      const { businessIds, technicalIds } = await seedInbox(admin.userId);
      const studentRow = await insert(student.userId, { title: 'Homework graded' });
      // A student-targeted row that merely LOOKS technical must survive: the
      // selection is structural (origin + source_event/category), not textual.
      const lookalike = await insert(student.userId, {
        title: '[WARNING][production] Component becomes degraded',
      });
      // The first three are produced by known technical producers and are
      // removed. The unknown-prefix legacy row and the non-admin homework row
      // are NOT matched by the narrow selection: they stay in the table (the
      // read filter still keeps them out of the admin inbox).
      const technicalNotes = technicalIds.slice(0, 3);
      const before = await counts();
      const runner = dataSource.createQueryRunner();
      try {
        await migration.up(runner);

        const after = await counts();
        expect(after.archived).toBe(technicalNotes.length);
        expect(after.total).toBe(before.total - technicalNotes.length);
        const remaining = (
          (await dataSource.query('SELECT id FROM "notifications"')) as Array<{ id: string }>
        ).map((row) => row.id);
        for (const id of technicalNotes) expect(remaining).not.toContain(id);
        for (const id of [
          ...businessIds,
          studentRow,
          lookalike,
          technicalIds[3]!,
          technicalIds[4]!,
        ]) {
          expect(remaining).toContain(id);
        }

        // Repeating the migration changes nothing.
        await migration.up(runner);
        expect(await counts()).toEqual(after);

        // Rollback restores exactly what was removed.
        await migration.down(runner);
        const reverted = await counts();
        expect(reverted.total).toBe(before.total);
        expect(reverted.archived).toBe(0);
        const restored = (
          (await dataSource.query('SELECT id FROM "notifications"')) as Array<{ id: string }>
        ).map((row) => row.id);
        for (const id of technicalNotes) expect(restored).toContain(id);
      } finally {
        await runner.release();
      }
    });

    it('is a no-op on a database with no technical alerts', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await business(admin.userId, AdminNotificationEvent.PURCHASE_COMPLETED, 'Payment completed');
      const runner = dataSource.createQueryRunner();
      try {
        await migration.up(runner);
        expect((await counts()).total).toBe(1);
        await migration.down(runner);
        expect((await counts()).total).toBe(1);
      } finally {
        await runner.release();
      }
    });
  });
});
