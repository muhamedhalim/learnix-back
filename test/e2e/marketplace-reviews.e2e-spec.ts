import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { LessonContentType } from '../../src/marketplace/common/enums';
import { MarketplaceEnrollment } from '../../src/marketplace/commerce/entities';
import { EnrollmentService } from '../../src/marketplace/commerce/enrollment.service';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { MarketplaceCourseReview } from '../../src/marketplace/reviews/entities';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * Phase 10's independent test (tasks.md): an enrolled learner posts, edits
 * and deletes a review; aggregates update; moderation hides it from public
 * surfaces and aggregates.
 */
describe('marketplace reviews — post, moderate, aggregate (Phase 10)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function seedInstructor(userId: string) {
    return dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: userId }));
  }

  async function seedCategory() {
    return dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
  }

  async function publishCourse(opts: {
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    categoryId: string;
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Review Flow Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'Learn and review',
        description: 'A full description of the course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: 0,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['Finish the course'],
      })
      .expect(201);
    const courseId = created.body.id as string;

    const section = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);

    for (let i = 0; i < 3; i++) {
      await opts.instructorAgent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          content_html: `<p>Content ${i + 1}</p>`,
          duration_seconds: 120,
          is_free_preview: i === 0,
        })
        .expect(201);
    }

    await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await opts.adminAgent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);

    return dataSource.getRepository(MarketplaceCourse).findOneOrFail({ where: { id: courseId } });
  }

  async function actors() {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await seedCategory();
    const course = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
    });
    await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
      .send({ courseId: course.id })
      .expect(201);
    return { instructorUser, admin, learner, course };
  }

  async function waitForListeners() {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  it('refuses a review from a learner without an active enrollment (FR-253)', async () => {
    const { course } = await actors();
    const outsider = await createAuthenticatedUser(app, dataSource);

    await outsider.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 5 })
      .expect(403);
  });

  it('posts, edits and deletes a review, with the public aggregate reflecting each change', async () => {
    const { learner, course } = await actors();

    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 4, comment: 'Pretty good' })
      .expect(201);
    expect(created.body).toMatchObject({ rating: 4, comment: 'Pretty good', status: 'approved' });

    const afterCreate = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}/reviews`)
      .expect(200);
    expect(afterCreate.body.data).toHaveLength(1);
    expect(afterCreate.body.meta.total).toBe(1);

    const detailAfterCreate = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}`)
      .expect(200);
    expect(detailAfterCreate.body.review_count).toBe(1);
    expect(detailAfterCreate.body.average_rating).toBe(4);

    await learner.agent
      .patch(`${API_PREFIX}/marketplace/me/reviews/${created.body.id}`)
      .send({ rating: 2 })
      .expect(200);

    const detailAfterEdit = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}`)
      .expect(200);
    expect(detailAfterEdit.body.average_rating).toBe(2);

    await learner.agent
      .delete(`${API_PREFIX}/marketplace/me/reviews/${created.body.id}`)
      .expect(200);

    const detailAfterDelete = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}`)
      .expect(200);
    expect(detailAfterDelete.body.review_count).toBe(0);
    expect(detailAfterDelete.body.average_rating).toBe(0);
  });

  it('aggregates the rating histogram in SQL: withdrawn and non-approved reviews are excluded (T079)', async () => {
    const { learner, course } = await actors();
    const others = [] as Awaited<ReturnType<typeof createAuthenticatedUser>>[];
    for (let i = 0; i < 4; i += 1) {
      const next = await createAuthenticatedUser(app, dataSource);
      await next.agent
        .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
        .send({ courseId: course.id })
        .expect(201);
      others.push(next);
    }
    const ratings = [5, 4, 4, 1, 3];
    const all = [learner, ...others];
    for (let i = 0; i < all.length; i += 1) {
      await all[i]!.agent.post(`${API_PREFIX}/marketplace/me/reviews`)
        .send({ courseId: course.id, rating: ratings[i] })
        .expect(201);
    }
    // The 4th review's purchase is refunded (withdrawn); the 5th is flagged by moderation.
    await dataSource.query(
      `UPDATE marketplace_course_reviews SET withdrawn_at = NOW() WHERE learner_id = $1`,
      [others[2]!.userId],
    );
    await dataSource.query(
      `UPDATE marketplace_course_reviews SET status = 'flagged' WHERE learner_id = $1`,
      [others[3]!.userId],
    );

    const detail = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}`)
      .expect(200);
    expect(detail.body.review_count).toBe(3);
    expect(detail.body.average_rating).toBe(4.33);
    expect(detail.body.rating_distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 2, 5: 1 });
  });

  it('refuses a second review for the same course from the same learner (FR-255)', async () => {
    const { learner, course } = await actors();
    await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 5 })
      .expect(201);

    const second = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 1 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REVIEW_ALREADY_EXISTS');
  });

  it('lets the owning instructor reply, edit and remove the reply, but refuses another instructor (FR-259)', async () => {
    const { instructorUser, learner, course } = await actors();
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 5 })
      .expect(201);

    const outsiderInstructor = await createAuthenticatedUser(app, dataSource);
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: outsiderInstructor.userId }));
    await outsiderInstructor.agent
      .post(`${API_PREFIX}/marketplace/instructor/reviews/${created.body.id}/reply`)
      .send({ reply: 'Not my course' })
      .expect(403);

    const replied = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/reviews/${created.body.id}/reply`)
      .send({ reply: 'Thanks for the feedback!' })
      .expect(201);
    expect(replied.body.instructor_reply).toBe('Thanks for the feedback!');

    const publicList = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}/reviews`)
      .expect(200);
    expect(publicList.body.data[0].instructor_reply).toBe('Thanks for the feedback!');

    const edited = await instructorUser.agent
      .put(`${API_PREFIX}/marketplace/instructor/reviews/${created.body.id}/reply`)
      .send({ reply: 'Edited reply' })
      .expect(200);
    expect(edited.body.instructor_reply).toBe('Edited reply');

    const removed = await instructorUser.agent
      .delete(`${API_PREFIX}/marketplace/instructor/reviews/${created.body.id}/reply`)
      .expect(200);
    expect(removed.body.instructor_reply).toBeNull();
  });

  it('lists every review across the instructor’s own courses with a per-course aggregate (FR-266)', async () => {
    const { instructorUser, learner, course } = await actors();
    await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 5 })
      .expect(201);

    const mine = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/reviews`)
      .expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.aggregatesByCourse[course.id]).toMatchObject({
      averageRating: 5,
      reviewCount: 1,
    });
  });

  it('reporting does not itself hide the review (FR-260), and moderation (hide) removes it from public surfaces and the aggregate', async () => {
    const { admin, learner, course } = await actors();
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 5 })
      .expect(201);

    const reporter = await createAuthenticatedUser(app, dataSource);
    await reporter.agent
      .post(`${API_PREFIX}/marketplace/reviews/${created.body.id}/report`)
      .send({ reason: 'Seems fake' })
      .expect(201);

    const stillVisible = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}/reviews`)
      .expect(200);
    expect(stillVisible.body.data).toHaveLength(1);

    const queue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/reviews`).expect(200);
    expect(queue.body.data.some((r: { id: string }) => r.id === created.body.id)).toBe(true);

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/reviews/${created.body.id}/moderate`)
      .send({ action: 'hide', reason: 'Under investigation' })
      .expect(201);

    const hidden = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}/reviews`)
      .expect(200);
    expect(hidden.body.data).toHaveLength(0);
    const detail = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}`)
      .expect(200);
    expect(detail.body.review_count).toBe(0);
  });

  it('requires a reason to hide or remove, but not to approve', async () => {
    const { admin, learner, course } = await actors();
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 3 })
      .expect(201);

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/reviews/${created.body.id}/moderate`)
      .send({ action: 'hide' })
      .expect(400);

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/reviews/${created.body.id}/moderate`)
      .send({ action: 'hide', reason: 'x' })
      .expect(201);

    const restored = await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/reviews/${created.body.id}/moderate`)
      .send({ action: 'approve' })
      .expect(201);
    expect(restored.body.status).toBe('approved');
  });

  it('withdraws the review when the underlying enrollment is revoked for any reason (FR-263)', async () => {
    const { learner, course } = await actors();
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 5 })
      .expect(201);

    const enrollment = await dataSource
      .getRepository(MarketplaceEnrollment)
      .findOneByOrFail({ learner_id: learner.userId, course_id: course.id });
    // No admin/generic-revocation HTTP endpoint exists yet to drive this —
    // invoked directly, matching the established e2e precedent of calling
    // a service method for an internal trigger with no controller in front
    // of it (e.g. `marketplace-learning.e2e-spec.ts`'s certificate test).
    const enrollmentService = app.get(EnrollmentService);
    await enrollmentService.revoke(enrollment.id, 'Suspended for cause');
    await waitForListeners();

    const review = await dataSource
      .getRepository(MarketplaceCourseReview)
      .findOneByOrFail({ id: created.body.id });
    expect(review.withdrawn_at).not.toBeNull();

    const publicList = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}/reviews`)
      .expect(200);
    expect(publicList.body.data).toHaveLength(0);
  });

  it('sorts the public list by recency (default) and by rating on request (FR-264)', async () => {
    const { course } = await actors();
    const learnerA = await createAuthenticatedUser(app, dataSource);
    const learnerB = await createAuthenticatedUser(app, dataSource);
    await learnerA.agent
      .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
      .send({ courseId: course.id })
      .expect(201);
    await learnerB.agent
      .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
      .send({ courseId: course.id })
      .expect(201);

    await learnerA.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 2 })
      .expect(201);
    await learnerB.agent
      .post(`${API_PREFIX}/marketplace/me/reviews`)
      .send({ courseId: course.id, rating: 5 })
      .expect(201);

    const byRating = await learnerA.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}/reviews?sort=rating`)
      .expect(200);
    expect(byRating.body.data[0].rating).toBe(5);

    const byRecency = await learnerA.agent
      .get(`${API_PREFIX}/marketplace/courses/${course.slug}/reviews`)
      .expect(200);
    expect(byRecency.body.data[0].rating).toBe(5); // learnerB reviewed last
  });
});
