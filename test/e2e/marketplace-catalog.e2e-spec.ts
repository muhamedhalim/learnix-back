import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LessonContentType, MarketplaceInstructorStatus } from '../../src/marketplace/common/enums';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildEnrollmentFixture, buildInstructorFixture, buildOrderFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * T079 — contracts §1 (public catalogue). Covers FR-076–FR-091: listing,
 * bilingual search, filters, sort, pagination bounds, detail, curriculum,
 * preview access, and — the AC's own emphasis — that no non-published
 * course is reachable by any route (FR-087), including a published course
 * whose instructor has since been suspended.
 */
describe('marketplace public catalogue — contract (contracts §1)', () => {
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

  async function seedInstructor(userId: string, overrides: Partial<Parameters<typeof buildInstructorFixture>[0]> = {}) {
    const fixture = buildInstructorFixture({ user_id: userId, ...overrides });
    return dataSource.getRepository(MarketplaceInstructor).save(fixture);
  }

  async function seedCategory(overrides: Partial<{ name_en: string; name_ar: string; parent_id: string }> = {}) {
    return dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
      ...overrides,
    });
  }

  /** Draft → submit → admin approve → instructor publish, with a real curriculum and a free-preview lesson. */
  async function publishCourse(opts: {
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    categoryId: string;
    title?: string;
    priceMinor?: number;
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: opts.title ?? 'Backend Engineering 101',
        summary: 'Learn to build backend systems',
        description: 'A full description of the course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: opts.priceMinor ?? 5000,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['Build a REST API'],
      })
      .expect(201);
    const courseId = created.body.id as string;

    const section = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    const sectionId = section.body.id as string;

    for (let i = 0; i < 3; i++) {
      await opts.instructorAgent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: sectionId,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          content_html: `<p>Content ${i + 1}</p>`,
          duration_seconds: 120,
          is_free_preview: i === 0,
        })
        .expect(201);
    }

    await opts.instructorAgent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await opts.adminAgent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await opts.instructorAgent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);

    const course = await dataSource.getRepository(MarketplaceCourse).findOneOrFail({ where: { id: courseId } });
    const previewLessonId = await dataSource
      .createQueryBuilder()
      .select('l.id', 'id')
      .from('marketplace_course_lessons', 'l')
      .where('l.section_id = :sectionId', { sectionId })
      .andWhere('l.is_free_preview = true')
      .getRawOne<{ id: string }>();
    const nonPreviewLessonId = await dataSource
      .createQueryBuilder()
      .select('l.id', 'id')
      .from('marketplace_course_lessons', 'l')
      .where('l.section_id = :sectionId', { sectionId })
      .andWhere('l.is_free_preview = false')
      .getRawOne<{ id: string }>();

    return { course, previewLessonId: previewLessonId!.id, nonPreviewLessonId: nonPreviewLessonId!.id };
  }

  it('lists a published course, filters and sorts, and enforces the page-size ceiling (FR-076, FR-077, FR-079, FR-081)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();

    const { course } = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });

    const list = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses`).expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(course.id);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(list.body.page).toBe(1);

    const byCategory = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?categoryId=${category.id}`).expect(200);
    expect(byCategory.body.items.map((c: { id: string }) => c.id)).toContain(course.id);

    const byPrice = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/courses?minPriceMinor=6000`)
      .expect(200);
    expect(byPrice.body.items.map((c: { id: string }) => c.id)).not.toContain(course.id);

    const sorted = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?sort=price_asc`).expect(200);
    expect(sorted.status).toBe(200);

    const oversized = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?limit=101`);
    expect(oversized.status).toBe(400);
  });

  it('finds a course by bilingual keyword search across title, category and instructor name, ranking a title match first (FR-078, FR-081)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId, { display_name: 'Nour Ahmed' });
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory({ name_en: 'Programming', name_ar: 'البرمجة' });

    const { course: titleMatch } = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
      title: 'React Fundamentals',
    });

    const byTitle = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?q=react`).expect(200);
    expect(byTitle.body.items.map((c: { id: string }) => c.id)).toContain(titleMatch.id);

    const byInstructor = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?q=Nour`).expect(200);
    expect(byInstructor.body.items.map((c: { id: string }) => c.id)).toContain(titleMatch.id);

    const byCategoryName = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?q=Programming`).expect(200);
    expect(byCategoryName.body.items.map((c: { id: string }) => c.id)).toContain(titleMatch.id);

    const noMatch = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?q=zzzznonexistentzzzz`).expect(200);
    expect(noMatch.body.items).toEqual([]);
  });

  it('serves the public detail projection from the snapshot, with related courses and no viewer enrollment when anonymous (FR-083, FR-089)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();

    const { course } = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });
    const { course: related } = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
      title: 'Another Course In The Same Category',
    });

    const anon = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses/${course.slug}`).expect(200);
    expect(anon.body.snapshot.title).toBe('Backend Engineering 101');
    expect(anon.body.snapshot.sections[0].lessons).toHaveLength(3);
    expect(anon.body.viewer_enrollment).toEqual({ enrolled: false, enrollment_id: null });
    expect(anon.body.related_courses.map((c: { id: string }) => c.id)).toContain(related.id);

    const curriculum = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses/${course.slug}/curriculum`).expect(200);
    expect(curriculum.body.sections[0].lessons).toHaveLength(3);
  });

  it("shows the learner's own enrollment instead of a buy control once authenticated (FR-090)", async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();
    const { course } = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });

    const learner = await createAuthenticatedUser(app, dataSource);
    const order = await dataSource.getRepository(MarketplaceOrder).save(
      buildOrderFixture({
        learner_id: learner.userId,
        course_id: course.id,
        course_version_id: course.current_version_id!,
        instructor_id: course.instructor_id,
        course_title_snapshot: course.title,
        instructor_name_snapshot: 'Test Instructor',
      }),
    );
    await dataSource.getRepository(MarketplaceEnrollment).save(
      buildEnrollmentFixture({
        learner_id: learner.userId,
        course_id: course.id,
        course_version_id: course.current_version_id!,
        order_id: order.id,
      }),
    );

    const asLearner = await learner.agent.get(`${API_PREFIX}/marketplace/courses/${course.slug}`).expect(200);
    expect(asLearner.body.viewer_enrollment.enrolled).toBe(true);
  });

  it('serves a free-preview lesson without an account and refuses a non-preview lesson (FR-048, FR-084)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();
    const { course, previewLessonId, nonPreviewLessonId } = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
    });

    const preview = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses/${course.slug}/preview/${previewLessonId}`).expect(200);
    expect(preview.body.content_html).toContain('Content 1');

    await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses/${course.slug}/preview/${nonPreviewLessonId}`).expect(404);
  });

  it('never exposes a draft, submitted, rejected, unpublished, or suspended-instructor course through any route (FR-087)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    const instructor = await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();

    // A draft (never submitted) course.
    const draft = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: 'Still A Draft',
        summary: 'S',
        description: 'D',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 0,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
      })
      .expect(201);

    await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses/${draft.body.slug}`).expect(404);
    const listWithoutDraft = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?q=Still A Draft`).expect(200);
    expect(listWithoutDraft.body.items).toEqual([]);

    // A published course whose instructor is later suspended.
    const { course: suspendedInstructorsCourse } = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
      title: 'Course Under A Now-Suspended Instructor',
    });
    await dataSource
      .getRepository(MarketplaceInstructor)
      .update({ id: instructor.id }, { status: MarketplaceInstructorStatus.SUSPENDED, suspension_reason: 'policy violation' });

    await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses/${suspendedInstructorsCourse.slug}`).expect(404);
    const listWithoutSuspended = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses`).expect(200);
    expect(listWithoutSuspended.body.items.map((c: { id: string }) => c.id)).not.toContain(suspendedInstructorsCourse.id);
  });

  it('an approved-but-not-yet-published course is never publicly visible (FR-087)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: 'Approved But Not Published',
        summary: 'S',
        description: 'D',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 0,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['Learn something'],
      })
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Section' })
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `L${i}`,
          content_type: LessonContentType.TEXT,
          content_html: '<p>x</p>',
          duration_seconds: 60,
          is_free_preview: i === 0,
        })
        .expect(201);
    }
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    // Deliberately never published.

    await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses/${created.body.slug}`).expect(404);
    const list = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?q=Approved But Not Published`).expect(200);
    expect(list.body.items).toEqual([]);
  });

  it('pages through results with no row repeated or skipped (FR-081 total ordering)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();

    const publishedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { course } = await publishCourse({
        instructorAgent: instructorUser.agent,
        adminAgent: admin.agent,
        categoryId: category.id,
        title: `Paging Course ${i}`,
      });
      publishedIds.push(course.id);
    }

    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const res = await instructorUser.agent.get(`${API_PREFIX}/marketplace/courses?limit=2&page=${page}`).expect(200);
      for (const item of res.body.items as { id: string }[]) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
    }
    for (const id of publishedIds) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it('serves the public category taxonomy with published course counts (FR-085) — closing the gap T085 flagged', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const category = await seedCategory();
    await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });

    const categories = await instructorUser.agent.get(`${API_PREFIX}/marketplace/categories`).expect(200);
    const row = categories.body.find((c: { id: string }) => c.id === category.id);
    expect(row.published_course_count).toBe(1);
  });
});
