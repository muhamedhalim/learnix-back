import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { HealthAlertRule } from '../../src/health/entities';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * API audit regression — `PATCH /health/alerts/:id`.
 *
 * Found by the route sweep: an unknown id surfaced a raw TypeORM `EntityNotFoundError`
 * as a 500, and a non-UUID id would have reached Postgres as an invalid-uuid error.
 * A partial update must also leave every field the caller did not send untouched.
 */
describe('health alert rule update (API audit)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seededRule(): Promise<HealthAlertRule> {
    const repo = dataSource.getRepository(HealthAlertRule);
    const existing = await repo.find({ take: 1 });
    if (existing[0] !== undefined) return existing[0];
    return repo.save(
      repo.create({
        key: 'audit-rule',
        name: 'Audit rule',
        component_id: 'redis',
        metric: 'memoryUsagePercent',
        operator: 'gte',
        threshold: 80,
        duration_seconds: 60,
        cooldown_seconds: 1800,
        severity: 'warning',
        channels: ['in_app', 'email'],
        recipients: [],
        enabled: true,
      }),
    );
  }

  it('refuses anonymous and non-admin callers', async () => {
    const rule = await seededRule();
    await request(server)
      .patch(`${API_PREFIX}/health/alerts/${rule.id}`)
      .send({ enabled: false })
      .expect(401);

    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    await teacher.agent
      .patch(`${API_PREFIX}/health/alerts/${rule.id}`)
      .send({ enabled: false })
      .expect(403);
  });

  it('answers 404 for an unknown rule id and 400 for a malformed one', async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });

    await admin.agent
      .patch(`${API_PREFIX}/health/alerts/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b`)
      .send({ enabled: false })
      .expect(404);
    await admin.agent
      .patch(`${API_PREFIX}/health/alerts/not-a-uuid`)
      .send({ enabled: false })
      .expect(400);
  });

  it('applies a partial update and preserves every field that was not sent', async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const before = await seededRule();

    const res = await admin.agent
      .patch(`${API_PREFIX}/health/alerts/${before.id}`)
      .send({ threshold: 91 })
      .expect(200);
    expect(res.body.threshold).toBe(91);

    const after = await dataSource
      .getRepository(HealthAlertRule)
      .findOneByOrFail({ id: before.id });
    expect(after.threshold).toBe(91);
    expect(after.enabled).toBe(before.enabled);
    expect(after.channels).toEqual(before.channels);
    expect(after.recipients).toEqual(before.recipients);
    expect(after.severity).toBe(before.severity);
    expect(after.cooldown_seconds).toBe(before.cooldown_seconds);
  });
});
