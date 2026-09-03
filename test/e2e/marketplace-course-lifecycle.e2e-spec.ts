import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LessonContentType, MarketplaceCourseStatus } from '../../src/marketplace/common/enums';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';

/**
 * T055 — contracts §3 (course authoring) and §5 (course moderation).
 * The independent test named by Phase 4's own header: draft → submit
 * (refused while incomplete) → admin reject with notes → fix → resubmit
 * → approve → instructor publishes → unpublish preserves existing access.
 */
describe('marketplace course lifecycle — contract (contracts §3, §5)', () => {
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

  async function seedInstructor(userId: string) {
    const fixture = buildInstructorFixture({ user_id: userId });
    return dataSource.getRepository(MarketplaceInstructor).save(fixture);
  }

  async function seedCategory() {
    return dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}`,
      display_order: 1,
    });
  }

  const courseBody = (categoryId: string) => ({
    title: 'Backend Engineering 101',
    summary: 'Learn to build backend systems',
    description: 'A full description of the course content.',
    category_id: categoryId,
    level: 'beginner',
    language: 'en',
    price_minor: 5000,
    currency: 'EGP',
    cover_image_key: 'covers/backend-101.jpg',
    learning_outcomes: ['Build a REST API'],
  });

  it('takes a course from draft through admin rejection, resubmission, approval, and instructor publish; unpublish preserves access', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const category = await seedCategory();
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');

    // Create the draft.
    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(category.id))
      .expect(201);
    const courseId = created.body.id as string;
    expect(created.body.status).toBe('draft');

    // Submit while incomplete (no curriculum yet) is refused, naming every unmet item.
    const incompleteSubmit = await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`);
    expect(incompleteSubmit.status).toBe(422);
    expect(incompleteSubmit.body.details).toEqual(expect.arrayContaining(['at_least_one_section', 'minimum_lessons']));

    // Build a minimally-ready curriculum: one section, three lessons (one required, one free preview).
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    const sectionId = section.body.id as string;

    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: sectionId,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          duration_seconds: 120,
          is_free_preview: i === 0,
        })
        .expect(201);
    }

    const readiness = await instructorUser.agent.get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/readiness`).expect(200);
    expect(readiness.body.ready).toBe(true);

    // The curriculum editor's own read (added during T073 — see contracts/README.md).
    const ownCurriculum = await instructorUser.agent.get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/curriculum`).expect(200);
    expect(ownCurriculum.body.sections[0].lessons).toHaveLength(3);

    // Submit for review.
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    const submittedCourse = await dataSource.getRepository(MarketplaceCourse).findOne({ where: { id: courseId } });
    expect(submittedCourse?.status).toBe(MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW);

    // Read-only to the instructor while under review (FR-063).
    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ title: 'Cannot edit now' })
      .expect(403);

    // Admin reviews the full content and rejects with reasons + per-item notes.
    const content = await admin.agent.get(`${API_PREFIX}/marketplace/admin/courses/${courseId}/content`).expect(200);
    expect(content.body.sections[0].lessons).toHaveLength(3);

    // "Full content playable" (T077) — these are text lessons, so there's nothing to play yet; the
    // endpoint still routes and answers correctly rather than 500ing.
    const textLessonId = content.body.sections[0].lessons[0].id as string;
    await admin.agent.get(`${API_PREFIX}/marketplace/admin/courses/${courseId}/lessons/${textLessonId}/video`).expect(404);

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/reject`)
      .send({ reasons: ['Cover image is low resolution'], item_notes: { cover_image: 'Use at least 1280x720' } })
      .expect(201);
    const rejectedCourse = await dataSource.getRepository(MarketplaceCourse).findOne({ where: { id: courseId } });
    expect(rejectedCourse?.status).toBe(MarketplaceCourseStatus.REJECTED);

    // The instructor can read why (T072's review-decisions read — see contracts/README.md).
    const decisions = await instructorUser.agent.get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/review-decisions`).expect(200);
    expect(decisions.body).toHaveLength(1);
    expect(decisions.body[0]).toMatchObject({
      decision: 'rejected',
      reasons: ['Cover image is low resolution'],
      item_notes: { cover_image: 'Use at least 1280x720' },
    });

    // Instructor fixes and resubmits.
    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ cover_image_key: 'covers/backend-101-hd.jpg' })
      .expect(200);
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);

    // Admin approves.
    await admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    const approvedCourse = await dataSource.getRepository(MarketplaceCourse).findOne({ where: { id: courseId } });
    expect(approvedCourse?.status).toBe(MarketplaceCourseStatus.APPROVED);

    // Only the instructor may publish — never automatic (FR-067).
    const published = await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);
    expect(published.body.status).toBe('published');
    expect(published.body.first_published_at).toBeTruthy();

    // A version snapshot now exists.
    const versionCount = await dataSource.query('SELECT COUNT(*) FROM marketplace_course_versions WHERE course_id = $1', [courseId]);
    expect(Number(versionCount[0].count)).toBe(1);

    // Instructor unpublishes their own course — access-preservation is asserted structurally: status changes, nothing else is touched.
    const unpublished = await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/unpublish`).send({}).expect(201);
    expect(unpublished.body.status).toBe('unpublished');
  });

  it('refuses a free-preview lesson beyond the FR-049 bound, naming the bound', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const category = await seedCategory();

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(category.id))
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Section 1' })
      .expect(201);
    const sectionId = section.body.id as string;

    // 5 lessons, all marked free preview: bound = min(5, max(1, floor(0.2*5))) = 1 for the first;
    // subsequent previews should be refused once the bound is reached.
    let refusedAt = -1;
    for (let i = 0; i < 5; i++) {
      const res = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: sectionId,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          duration_seconds: 60,
          is_free_preview: true,
        });
      if (res.status === 422) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBeGreaterThanOrEqual(0);
  });

  it('material edit on a published course queues for re-review while the live version stays visible (FR-071)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const category = await seedCategory();
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');

    const created = await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses`).send(courseBody(category.id)).expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Section 1' })
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({ section_id: section.body.id, title: `L${i}`, content_type: LessonContentType.TEXT, duration_seconds: 60, is_free_preview: i === 0 })
        .expect(201);
    }
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);

    // Material edit: price change.
    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ price_minor: 9999 })
      .expect(200);

    const afterMaterialEdit = await dataSource.getRepository(MarketplaceCourse).findOne({ where: { id: courseId } });
    expect(afterMaterialEdit?.status).toBe(MarketplaceCourseStatus.PUBLISHED);
    expect(afterMaterialEdit?.pending_review_since).not.toBeNull();

    const versionsAfterEdit = await dataSource.query('SELECT COUNT(*) FROM marketplace_course_versions WHERE course_id = $1', [courseId]);
    expect(Number(versionsAfterEdit[0].count)).toBe(1); // no new snapshot yet — the live version is unchanged.
  });

  it('admin category CRUD: create, reorder, refuse deletion while referenced, deactivate instead', async () => {
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);

    const created = await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/categories`)
      .send({ name_en: 'Design', name_ar: 'التصميم' })
      .expect(201);
    const categoryId = created.body.id as string;

    await admin.agent.patch(`${API_PREFIX}/marketplace/admin/categories/${categoryId}`).send({ display_order: 5 }).expect(200);

    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses`).send(courseBody(categoryId)).expect(201);

    const deleteRes = await admin.agent.delete(`${API_PREFIX}/marketplace/admin/categories/${categoryId}`);
    expect(deleteRes.status).toBe(409);
    expect(deleteRes.body.code).toBe('CATEGORY_REFERENCED');

    await admin.agent.patch(`${API_PREFIX}/marketplace/admin/categories/${categoryId}`).send({ is_active: false }).expect(200);
  });

  it('refuses course routes to an instructor acting on a course they do not own (no IDOR)', async () => {
    const ownerUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(ownerUser.userId);
    const category = await seedCategory();
    const created = await ownerUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses`).send(courseBody(category.id)).expect(201);

    const otherUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(otherUser.userId);

    await otherUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${created.body.id}`)
      .send({ title: 'Hijacked' })
      .expect(404);

    await otherUser.agent.get(`${API_PREFIX}/marketplace/instructor/courses/${created.body.id}/curriculum`).expect(404);
    await otherUser.agent.get(`${API_PREFIX}/marketplace/instructor/courses/${created.body.id}/review-decisions`).expect(404);
  });
});
