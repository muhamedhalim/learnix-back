import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { InstructorApplication } from '../../src/marketplace/instructors/entities/instructor-application.entity';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';

/**
 * API audit — `GET /marketplace/admin/overview` (FR-286).
 *
 * The route answered "Cannot GET" in production because the deployed task
 * environment never set `MARKETPLACE_ENABLED=true`, so `MarketplaceModule` was not in
 * the module graph at all (see `marketplace-disabled.e2e-spec.ts` for the flag-off
 * half). These tests pin the other half: with the module loaded, the endpoint is
 * reachable, guarded, correctly shaped, and its numbers follow real state changes
 * made through the public API rather than a stubbed or fixed response.
 */
describe('marketplace admin overview (FR-286)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;

  const OVERVIEW = `${API_PREFIX}/marketplace/admin/overview`;
  const QUEUES = ['applications', 'courses', 'reportedReviews', 'refunds', 'payouts'] as const;

  const submittableApplication = {
    display_name: 'Nour Ahmed',
    photo_key: 'https://cdn.example.com/photos/nour.jpg',
    headline: 'Senior Software Engineer',
    bio: 'Ten years building backend systems.',
    years_of_experience: 10,
    specializations: ['Backend Development'],
    intended_category_ids: ['11111111-1111-4111-8111-111111111111'],
    professional_links: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/example' }],
  };

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

  it('is reachable (not 404) and refuses anonymous callers with 401 and non-admins with 403', async () => {
    await request(server).get(OVERVIEW).expect(401);

    const learner = await createAuthenticatedUser(app, dataSource);
    await learner.agent.get(OVERVIEW).expect(403);

    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    await teacher.agent.get(OVERVIEW).expect(403);
  });

  it('returns all five queues with count 0 and no oldest-waiting time on an empty platform, never cached', async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });

    const res = await admin.agent.get(OVERVIEW).expect(200);

    expect(Object.keys(res.body).sort()).toEqual([...QUEUES].sort());
    for (const queue of QUEUES) {
      expect(res.body[queue]).toEqual({ count: 0, oldestWaitingSince: null });
    }
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('counts an instructor application while it waits and stops counting it once decided', async () => {
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');

    const learner = await createAuthenticatedUser(app, dataSource);
    await learner.agent
      .post(`${API_PREFIX}/marketplace/applications`)
      .send({ display_name: 'Nour' })
      .expect(201);
    await learner.agent
      .patch(`${API_PREFIX}/marketplace/applications/me`)
      .send(submittableApplication)
      .expect(200);

    // A draft is not waiting for an admin.
    const draftOverview = await admin.agent.get(OVERVIEW).expect(200);
    expect(draftOverview.body.applications.count).toBe(0);

    const before = Date.now();
    await learner.agent
      .post(`${API_PREFIX}/marketplace/applications/me/submit`)
      .send({})
      .expect(201);

    const waiting = await admin.agent.get(OVERVIEW).expect(200);
    expect(waiting.body.applications.count).toBe(1);
    const oldest = Date.parse(waiting.body.applications.oldestWaitingSince as string);
    expect(Number.isNaN(oldest)).toBe(false);
    // Allow for timestamp-without-timezone rounding and clock skew between app and database.
    expect(Math.abs(oldest - before)).toBeLessThan(5 * 60_000);
    for (const queue of QUEUES.filter((q) => q !== 'applications')) {
      expect(waiting.body[queue]).toEqual({ count: 0, oldestWaitingSince: null });
    }

    const application = await dataSource
      .getRepository(InstructorApplication)
      .findOneOrFail({ where: { user_id: learner.userId } });
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/applications/${application.id}/reject`)
      .send({ reason: 'Incomplete portfolio' })
      .expect(201);

    const decided = await admin.agent.get(OVERVIEW).expect(200);
    expect(decided.body.applications).toEqual({ count: 0, oldestWaitingSince: null });
  });
});
