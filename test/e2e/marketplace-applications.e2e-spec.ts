import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MarketplaceInstructorStatus } from '../../src/marketplace/common/enums';
import { InstructorApplication } from '../../src/marketplace/instructors/entities/instructor-application.entity';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';

/**
 * Contract tests for contracts §2 (learner-facing applications) and the
 * application-related rows of §5 (admin review) — every route T045's
 * `ApplicationsController` and T046's `AdminApplicationsController` expose.
 * Also covers T047's FR-027 prohibited-field assertion, since it is a small
 * addition to the same instructor-domain fixtures rather than a spec of its own.
 */
describe('marketplace applications — contract (contracts §2, §5)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;

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

  describe('learner application lifecycle', () => {
    it('has no application initially, then can create, edit, submit and withdraw one', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);

      await learner.agent.get(`${API_PREFIX}/marketplace/applications/me`).expect(404);

      const created = await learner.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({ display_name: 'Nour' })
        .expect(201);
      expect(created.body.status).toBe('draft');

      await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send({ headline: 'Updated headline' })
        .expect(200);

      const incomplete = await learner.agent
        .post(`${API_PREFIX}/marketplace/applications/me/submit`)
        .send({});
      expect(incomplete.status).toBe(422);
      expect(incomplete.body.code).toBe('APPLICATION_NOT_READY_FOR_SUBMISSION');

      await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send(submittableApplication)
        .expect(200);

      const submitted = await learner.agent
        .post(`${API_PREFIX}/marketplace/applications/me/submit`)
        .send({})
        .expect(201);
      expect(submitted.body.status).toBe('submitted');

      const withdrawn = await learner.agent
        .post(`${API_PREFIX}/marketplace/applications/me/withdraw`)
        .send({})
        .expect(201);
      expect(withdrawn.body.status).toBe('withdrawn');
    });

    it('opens an empty draft from an empty body instead of failing a NOT NULL constraint', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);

      const created = await learner.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({})
        .expect(201);

      expect(created.body.status).toBe('draft');
      const row = await dataSource
        .getRepository(InstructorApplication)
        .findOneOrFail({ where: { user_id: learner.userId } });
      expect(row.display_name).toBe('');
      expect(row.years_of_experience).toBe(0);
    });

    it('refuses a second open application with 409 (FR-015)', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({ display_name: 'Nour' })
        .expect(201);

      const second = await learner.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({ display_name: 'Nour' });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('APPLICATION_ALREADY_OPEN');
    });

    it('uploads a private supporting document and returns a key, never a URL (FR-303)', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({ display_name: 'Nour' })
        .expect(201);

      const upload = await learner.agent
        .post(`${API_PREFIX}/marketplace/applications/me/documents`)
        .attach('file', Buffer.from('%PDF-1.4 fake'), {
          filename: 'diploma.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      expect(typeof upload.body.key).toBe('string');
      expect(upload.body.url).toBeUndefined();
    });

    it('refuses every route to an unauthenticated caller', async () => {
      await request(server).get(`${API_PREFIX}/marketplace/applications/me`).expect(401);
      await request(server).post(`${API_PREFIX}/marketplace/applications`).send({}).expect(401);
    });
  });

  describe('admin application review', () => {
    it('queues, decides and audits an application (FR-017, FR-018, FR-019)', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({ display_name: 'Nour' })
        .expect(201);
      await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send(submittableApplication)
        .expect(200);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/applications/me/submit`)
        .send({})
        .expect(201);

      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');

      const queue = await admin.agent
        .get(`${API_PREFIX}/marketplace/admin/applications`)
        .expect(200);
      expect(queue.body.items).toHaveLength(1);
      const applicationId = queue.body.items[0].id as string;

      const dossier = await admin.agent
        .get(`${API_PREFIX}/marketplace/admin/applications/${applicationId}`)
        .expect(200);
      expect(dossier.body.status).toBe('under_review');
      expect(dossier.body.documents).toEqual([]);

      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/approve`)
        .send({})
        .expect(201);

      const instructorRow = await dataSource
        .getRepository(MarketplaceInstructor)
        .findOne({ where: { user_id: learner.userId } });
      expect(instructorRow?.status).toBe(MarketplaceInstructorStatus.APPROVED);
    });

    it('requires a mandatory reason to reject (FR-018, FR-020)', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({ display_name: 'Nour' })
        .expect(201);
      await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send(submittableApplication)
        .expect(200);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/applications/me/submit`)
        .send({})
        .expect(201);

      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');
      const applicationRow = await dataSource
        .getRepository(InstructorApplication)
        .findOneOrFail({ where: { user_id: learner.userId } });

      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationRow.id}/reject`)
        .send({})
        .expect(400);

      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationRow.id}/reject`)
        .send({ reason: 'Incomplete portfolio' })
        .expect(201);

      const rejected = await dataSource
        .getRepository(InstructorApplication)
        .findOne({ where: { id: applicationRow.id } });
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.decision_reason).toBe('Incomplete portfolio');
    });

    it('lifts the resubmission block via reset-attempts, reason mandatory (FR-016)', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');

      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/applicants/${learner.userId}/reset-attempts`)
        .send({})
        .expect(400);
      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/applicants/${learner.userId}/reset-attempts`)
        .send({ reason: 'Circumstances changed' })
        .expect(201);
    });

    it('refuses admin routes to a non-admin caller (403)', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent.get(`${API_PREFIX}/marketplace/admin/applications`).expect(403);
    });
  });

  describe('public instructor profile — FR-027 prohibited fields (T047)', () => {
    it('never exposes contact details, application content, earnings or payout data', async () => {
      const owner = await createAuthenticatedUser(app, dataSource);
      const fixture = buildInstructorFixture({ user_id: owner.userId });
      await dataSource.getRepository(MarketplaceInstructor).save(fixture);

      const response = await request(server)
        .get(`${API_PREFIX}/marketplace/instructors/${fixture.slug}`)
        .expect(200);

      const forbiddenKeys = [
        'email',
        'phone',
        'address',
        'national_id',
        'document_keys',
        'application_id',
        'earnings',
        'balance',
        'ledger',
        'payout_accounts',
        'payout_history',
        'suspension_reason',
        'internal_notes',
      ];
      for (const key of forbiddenKeys) {
        expect(response.body).not.toHaveProperty(key);
      }
      expect(response.body.published_courses).toEqual([]);
    });

    it('returns 404 for a suspended instructor, never 403 (FR-032)', async () => {
      const owner = await createAuthenticatedUser(app, dataSource);
      const fixture = buildInstructorFixture({
        user_id: owner.userId,
        status: MarketplaceInstructorStatus.SUSPENDED,
        suspension_reason: 'Policy violation',
      });
      await dataSource.getRepository(MarketplaceInstructor).save(fixture);

      await request(server)
        .get(`${API_PREFIX}/marketplace/instructors/${fixture.slug}`)
        .expect(404);
    });

    it('returns 404 for a slug that does not exist', async () => {
      await request(server).get(`${API_PREFIX}/marketplace/instructors/does-not-exist`).expect(404);
    });
  });
});
