import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MarketplaceInstructorStatus } from '../../src/marketplace/common/enums';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';

/**
 * T039 — the FR-294 authorization matrix for `ApprovedInstructorGuard`,
 * asserted at the API (T048's `InstructorProfileController`), not the UI.
 * Every case proves the guard reads only the `marketplace_instructors`
 * capability row, never `users.role` (Q2, FR-009, FR-302).
 */
describe('marketplace instructor capability — authorization matrix (FR-294)', () => {
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

  it('approved: full read and write access', async () => {
    const user = await createAuthenticatedUser(app, dataSource);
    const fixture = buildInstructorFixture({ user_id: user.userId, status: MarketplaceInstructorStatus.APPROVED });
    await dataSource.getRepository(MarketplaceInstructor).save(fixture);

    await user.agent.get(`${API_PREFIX}/marketplace/instructor/profile`).expect(200);
    await user.agent
      .patch(`${API_PREFIX}/marketplace/instructor/profile`)
      .send({ skills: ['typescript'] })
      .expect(200);
  });

  it('suspended: read allowed, write refused with 403 (FR-301)', async () => {
    const user = await createAuthenticatedUser(app, dataSource);
    const fixture = buildInstructorFixture({ user_id: user.userId, status: MarketplaceInstructorStatus.SUSPENDED, suspension_reason: 'Policy violation' });
    await dataSource.getRepository(MarketplaceInstructor).save(fixture);

    await user.agent.get(`${API_PREFIX}/marketplace/instructor/profile`).expect(200);
    await user.agent
      .patch(`${API_PREFIX}/marketplace/instructor/profile`)
      .send({ skills: ['typescript'] })
      .expect(403);
  });

  it('absent: no marketplace_instructors row at all — refused on every method', async () => {
    const user = await createAuthenticatedUser(app, dataSource);

    await user.agent.get(`${API_PREFIX}/marketplace/instructor/profile`).expect(403);
    await user.agent.patch(`${API_PREFIX}/marketplace/instructor/profile`).send({}).expect(403);
  });

  it('academic-teacher-only: users.role = teacher with no capability row is refused identically to absent', async () => {
    const user = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, user.userId, 'teacher');

    await user.agent.get(`${API_PREFIX}/marketplace/instructor/profile`).expect(403);
  });

  it('withdrawn: treated as absent, not a live capability', async () => {
    const user = await createAuthenticatedUser(app, dataSource);
    const fixture = buildInstructorFixture({ user_id: user.userId, status: MarketplaceInstructorStatus.WITHDRAWN });
    await dataSource.getRepository(MarketplaceInstructor).save(fixture);

    await user.agent.get(`${API_PREFIX}/marketplace/instructor/profile`).expect(403);
  });

  it('unauthenticated: refused with 401 before the capability check ever runs', async () => {
    await request(server).get(`${API_PREFIX}/marketplace/instructor/profile`).expect(401);
  });
});
