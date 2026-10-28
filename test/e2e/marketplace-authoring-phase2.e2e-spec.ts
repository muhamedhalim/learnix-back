import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LessonContentType } from '../../src/marketplace/common/enums';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * Phase 2 of the marketplace remediation: the authoring seams between the instructor forms and the
 * backend. Real Postgres, real guards, real services.
 *
 *  - MP-07  a whole form saved back unchanged must not wedge a published course in "pending review",
 *           and a real material edit must be decidable by an administrator;
 *  - MP-11  EGP-only pricing, with the registry's bounds;
 *  - MP-08  a rejected application stays visible to its applicant;
 *  - MP-13  a supporting document goes to the application the applicant is actually editing.
 */
describe('marketplace authoring — phase 2 seams', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  const courseBody = (categoryId: string) => ({
    title: 'Backend Engineering 101',
    summary: 'Learn to build backend systems',
    description: 'A full description of the course content.',
    category_id: categoryId,
    level: 'beginner',
    language: 'en',
    price_minor: 10_000,
    currency: 'EGP',
    cover_image_key: TEST_IMAGE_KEY,
    learning_outcomes: ['Build a REST API'],
  });

  async function setup() {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}`,
      display_order: 1,
    });
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    return { instructor: instructorUser, admin, category };
  }

  async function publishedCourse() {
    const ctx = await setup();
    const base = `${API_PREFIX}/marketplace/instructor/courses`;
    const created = await ctx.instructor.agent.post(base).send(courseBody(ctx.category.id)).expect(201);
    const courseId = created.body.id as string;
    const section = await ctx.instructor.agent.post(`${base}/${courseId}/sections`).send({ title: 'Start' }).expect(201);
    for (let i = 0; i < 3; i++) {
      await ctx.instructor.agent
        .post(`${base}/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          duration_seconds: 120,
          is_free_preview: i === 0,
        })
        .expect(201);
    }
    await ctx.instructor.agent.post(`${base}/${courseId}/submit`).send({}).expect(201);
    await ctx.admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await ctx.instructor.agent.post(`${base}/${courseId}/publish`).send({}).expect(201);
    return { ...ctx, courseId, base };
  }

  const versionCount = async (courseId: string): Promise<number> => {
    const rows = (await dataSource.query(
      'SELECT COUNT(*)::int AS n FROM marketplace_course_versions WHERE course_id = $1',
      [courseId],
    )) as Array<{ n: number }>;
    return rows[0].n;
  };
  const pendingSince = async (courseId: string): Promise<Date | null> =>
    (await dataSource.getRepository(MarketplaceCourse).findOneOrFail({ where: { id: courseId } })).pending_review_since;

  describe('pricing is EGP-only and bounded (MP-11, D4)', () => {
    it('refuses another currency, and a paid price outside the registry bounds, on create and on update', async () => {
      const { instructor, category } = await setup();
      const base = `${API_PREFIX}/marketplace/instructor/courses`;

      await instructor.agent.post(base).send({ ...courseBody(category.id), currency: 'USD' }).expect(400);
      await instructor.agent.post(base).send({ ...courseBody(category.id), price_minor: 100 }).expect(400);
      await instructor.agent.post(base).send({ ...courseBody(category.id), price_minor: 2_000_001 }).expect(400);

      const created = await instructor.agent.post(base).send(courseBody(category.id)).expect(201);
      const id = created.body.id as string;
      await instructor.agent.patch(`${base}/${id}`).send({ currency: 'SAR' }).expect(400);
      await instructor.agent.patch(`${base}/${id}`).send({ price_minor: 100 }).expect(400);
      const ok = await instructor.agent.patch(`${base}/${id}`).send({ price_minor: 25_000 }).expect(200);
      expect(ok.body.price_minor).toBe(25_000);

      // A free course is always inside the bounds.
      await instructor.agent.patch(`${base}/${id}`).send({ price_minor: 0 }).expect(200);
    });

    it('does not let a course in a non-enabled currency be submitted', async () => {
      const { instructor, category } = await setup();
      const base = `${API_PREFIX}/marketplace/instructor/courses`;
      const created = await instructor.agent.post(base).send(courseBody(category.id)).expect(201);
      const id = created.body.id as string;
      // A legacy row that predates the rule.
      await dataSource.getRepository(MarketplaceCourse).update(id, { currency: 'USD' });

      const readiness = await instructor.agent.get(`${base}/${id}/readiness`).expect(200);
      expect(readiness.body.items.find((i: { key: string }) => i.key === 'currency').passed).toBe(false);
      expect(readiness.body.ready).toBe(false);

      // Unrelated edits to that legacy course are still possible.
      await instructor.agent.patch(`${base}/${id}`).send({ title: 'Retitled', currency: 'USD', price_minor: 10_000 }).expect(200);
    });
  });

  describe('edits to a published course (MP-07)', () => {
    it('saving the whole form back unchanged neither publishes a version nor queues a review', async () => {
      const { instructor, courseId, base, category } = await publishedCourse();
      const before = await versionCount(courseId);

      await instructor.agent.patch(`${base}/${courseId}`).send(courseBody(category.id)).expect(200);

      expect(await pendingSince(courseId)).toBeNull();
      expect(await versionCount(courseId)).toBe(before);
    });

    it('a cosmetic edit in a whole-form save is published at once; a price change waits for an administrator', async () => {
      const { instructor, admin, courseId, base, category } = await publishedCourse();
      const before = await versionCount(courseId);

      await instructor.agent
        .patch(`${base}/${courseId}`)
        .send({ ...courseBody(category.id), title: 'Backend Engineering 101 (updated)' })
        .expect(200);
      expect(await pendingSince(courseId)).toBeNull();
      expect(await versionCount(courseId)).toBe(before + 1);

      await instructor.agent
        .patch(`${base}/${courseId}`)
        .send({ ...courseBody(category.id), title: 'Backend Engineering 101 (updated)', price_minor: 30_000 })
        .expect(200);
      expect(await pendingSince(courseId)).not.toBeNull();
      expect(await versionCount(courseId)).toBe(before + 1);

      // A later typo fix must not carry the unapproved price into the public version.
      await instructor.agent
        .patch(`${base}/${courseId}`)
        .send({ ...courseBody(category.id), title: 'Backend Engineering 101 (updated!)', price_minor: 30_000 })
        .expect(200);
      expect(await versionCount(courseId)).toBe(before + 1);

      // The admin queue lists it, and only it.
      const queue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/courses?pending_edit=true`).expect(200);
      expect((queue.body as Array<{ id: string }>).map((c) => c.id)).toEqual([courseId]);
      const everything = await admin.agent.get(`${API_PREFIX}/marketplace/admin/courses?pending_edit=false`).expect(200);
      expect((everything.body as unknown[]).length).toBeGreaterThanOrEqual(1);

      // Approval publishes the pending state as the new public version and empties the queue.
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/pending-edit/approve`).send({}).expect(201);
      expect(await pendingSince(courseId)).toBeNull();
      expect(await versionCount(courseId)).toBe(before + 2);
      const emptyQueue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/courses?pending_edit=true`).expect(200);
      expect(emptyQueue.body).toEqual([]);

      // Nothing left to decide.
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/pending-edit/approve`).send({}).expect(404);

      const audit = (await dataSource.query(
        "SELECT action FROM audit_logs WHERE action = 'marketplace_course_pending_edit_approved'",
      )) as unknown[];
      expect(audit).toHaveLength(1);
    });

    it('a rejected edit needs reasons, clears the queue and tells the instructor why; the public version is untouched', async () => {
      const { instructor, admin, courseId, base, category } = await publishedCourse();
      const before = await versionCount(courseId);
      await instructor.agent
        .patch(`${base}/${courseId}`)
        .send({ ...courseBody(category.id), price_minor: 40_000 })
        .expect(200);
      expect(await pendingSince(courseId)).not.toBeNull();

      const reject = `${API_PREFIX}/marketplace/admin/courses/${courseId}/pending-edit/reject`;
      await admin.agent.post(reject).send({ reasons: [] }).expect(400);
      await admin.agent.post(reject).send({ reasons: ['Price is out of line with the content'] }).expect(201);

      expect(await pendingSince(courseId)).toBeNull();
      expect(await versionCount(courseId)).toBe(before);
      const decisions = await instructor.agent.get(`${base}/${courseId}/review-decisions`).expect(200);
      expect((decisions.body as Array<{ decision: string; reasons: string[] }>)[0]).toMatchObject({
        decision: 'rejected',
        reasons: ['Price is out of line with the content'],
      });
    });

    it('keeps the pending-edit endpoints to administrators', async () => {
      const { instructor, courseId } = await publishedCourse();
      await instructor.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/pending-edit/approve`).send({}).expect(403);
      await instructor.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/pending-edit/reject`).send({ reasons: ['x'] }).expect(403);
      await instructor.agent.get(`${API_PREFIX}/marketplace/admin/courses?pending_edit=true`).expect(403);
    });

    it('two administrators deciding at once get exactly one outcome', async () => {
      const { instructor, admin, courseId, base, category } = await publishedCourse();
      await instructor.agent.patch(`${base}/${courseId}`).send({ ...courseBody(category.id), price_minor: 50_000 }).expect(200);
      const second = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, second.userId, 'admin');

      const url = `${API_PREFIX}/marketplace/admin/courses/${courseId}/pending-edit/approve`;
      const results = await Promise.all([admin.agent.post(url).send({}), second.agent.post(url).send({})]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    });
  });

  describe('instructor applications (MP-08, MP-13)', () => {
    const application = {
      display_name: 'Nour Ahmed',
      photo_key: TEST_IMAGE_KEY,
      headline: 'Senior Software Engineer',
      bio: 'Ten years building backend systems.',
      years_of_experience: 10,
      specializations: ['Backend Development'],
      intended_category_ids: ['11111111-1111-4111-8111-111111111111'],
      professional_links: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/example' }],
    };

    it('shows the applicant their rejected application with the reason, lets them edit it, and still hides a withdrawn one', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications`).send({ display_name: 'Nour' }).expect(201);
      await learner.agent.patch(`${API_PREFIX}/marketplace/applications/me`).send(application).expect(200);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications/me/submit`).send({}).expect(201);

      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');
      const queue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/applications`).expect(200);
      const id = queue.body.items[0].id as string;
      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${id}/reject`)
        .send({ reason: 'Please add a portfolio link' })
        .expect(201);

      const mine = await learner.agent.get(`${API_PREFIX}/marketplace/applications/me`).expect(200);
      expect(mine.body).toMatchObject({ id, status: 'rejected', decision_reason: 'Please add a portfolio link' });

      // It is the row they edit and resubmit.
      const edited = await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send({ headline: 'Staff Engineer' })
        .expect(200);
      expect(edited.body.id).toBe(id);

      // Withdrawn applications are the applicant's own choice and are not offered back.
      const other = await createAuthenticatedUser(app, dataSource);
      await other.agent.post(`${API_PREFIX}/marketplace/applications`).send({ display_name: 'Sara' }).expect(201);
      await other.agent.post(`${API_PREFIX}/marketplace/applications/me/withdraw`).send({}).expect(201);
      await other.agent.get(`${API_PREFIX}/marketplace/applications/me`).expect(404);
    });

    it('attaches a supporting document to the application being edited, not to an older rejected one', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications`).send({ display_name: 'Nour' }).expect(201);
      await learner.agent.patch(`${API_PREFIX}/marketplace/applications/me`).send(application).expect(200);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications/me/submit`).send({}).expect(201);
      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');
      const queue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/applications`).expect(200);
      const rejectedId = queue.body.items[0].id as string;
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/applications/${rejectedId}/reject`).send({ reason: 'More detail' }).expect(201);

      // A second, newer draft next to the rejected one (once the wait is over the applicant opens a fresh draft).
      await dataSource.query(
        "UPDATE marketplace_instructor_applications SET reviewed_at = now() - interval '30 days' WHERE id = $1",
        [rejectedId],
      );
      const draft = await learner.agent.post(`${API_PREFIX}/marketplace/applications`).send({ display_name: 'Nour' }).expect(201);
      const draftId = draft.body.id as string;

      await learner.agent
        .post(`${API_PREFIX}/marketplace/applications/me/documents`)
        .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'cert.pdf', contentType: 'application/pdf' })
        .expect(201);

      const rows = (await dataSource.query(
        'SELECT id, cardinality(document_keys) AS n FROM marketplace_instructor_applications WHERE user_id = $1',
        [learner.userId],
      )) as Array<{ id: string; n: number }>;
      expect(rows.find((r) => r.id === draftId)?.n).toBe(1);
      expect(rows.find((r) => r.id === rejectedId)?.n).toBe(0);
    });
  });
});
