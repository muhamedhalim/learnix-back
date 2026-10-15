import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LessonContentType } from '../../src/marketplace/common/enums';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment } from '../../src/marketplace/commerce/entities';
import { EnrollmentService } from '../../src/marketplace/commerce/enrollment.service';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { Certificate } from '../../src/certificates/entities/certificate.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';

/**
 * Phase 8's independent test (tasks.md): complete a short and a long
 * required lesson — progress moves by the same amount for each because
 * duration is irrelevant; an optional lesson moves it not at all;
 * completing every required lesson issues one verifiable certificate.
 * Also T125's player/content-access contract and T126/T127's
 * issuance/revocation, end to end through the real HTTP surface.
 */
describe('marketplace learning — progress, completion, certificates (Phase 8)', () => {
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

  /**
   * A free, certificate-enabled course with three lessons in one section:
   * lesson 0 is a free preview (optional by FR-242's default), lesson 1 is
   * required with a SHORT duration, lesson 2 is required with a LONG
   * duration — proving duration never enters the progress calculation.
   */
  async function publishCourse(opts: {
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    categoryId: string;
    certificateEnabled?: boolean;
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Learning Flow Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'Learn and complete',
        description: 'A full description of the course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: 0,
        currency: 'EGP',
        cover_image_key: 'covers/learning-101.jpg',
        learning_outcomes: ['Finish the course'],
        certificate_enabled: opts.certificateEnabled ?? true,
      })
      .expect(201);
    const courseId = created.body.id as string;

    const section = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    const sectionId = section.body.id as string;

    const preview = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
      .send({
        section_id: sectionId,
        title: 'Welcome (preview)',
        content_type: LessonContentType.TEXT,
        content_html: '<p>Welcome</p>',
        duration_seconds: 30,
        is_free_preview: true,
      })
      .expect(201);

    const shortLesson = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
      .send({
        section_id: sectionId,
        title: 'Short required lesson',
        content_type: LessonContentType.TEXT,
        content_html: '<p>Short</p>',
        duration_seconds: 60,
        is_required_for_completion: true,
      })
      .expect(201);

    // Deliberately TEXT, not VIDEO: course submission's readiness check
    // (`CourseReadinessService.allVideoLessonsReady`) needs a transcoded AWS
    // video asset for any video lesson, which this e2e environment has no
    // MediaConvert to produce — the same constraint documented for
    // T077/T065/T074. Duration is the only thing this lesson varies from
    // the short one; content type is irrelevant to what's being proven.
    const longLesson = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
      .send({
        section_id: sectionId,
        title: 'Long required lesson',
        content_type: LessonContentType.TEXT,
        content_html: '<p>Long</p>',
        duration_seconds: 36_000,
        is_required_for_completion: true,
      })
      .expect(201);

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

    const course = await dataSource
      .getRepository(MarketplaceCourse)
      .findOneOrFail({ where: { id: courseId } });
    return {
      course,
      previewLessonId: preview.body.id as string,
      shortLessonId: shortLesson.body.id as string,
      longLessonId: longLesson.body.id as string,
    };
  }

  async function actors(certificateEnabled = true) {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await seedCategory();
    const fixtures = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
      certificateEnabled,
    });
    const enrollRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
      .send({ courseId: fixtures.course.id })
      .expect(201);
    return {
      instructorUser,
      admin,
      learner,
      ...fixtures,
      enrollmentOrderId: enrollRes.body.id as string,
    };
  }

  /** enroll-free returns the *order*; resolve the actual enrollment row from it. */
  async function getEnrollment(orderId: string) {
    return dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ order_id: orderId });
  }

  /** `MarketplaceCertificateIssuanceService`'s `@OnEvent` handlers run on a plain (non-awaited) `emit()`, so a completion/revocation's certificate side effect can still be in flight when the triggering HTTP call has already returned. */
  async function waitForListeners() {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  it('progresses by the same amount for a short and a long required lesson, ignores an optional lesson, and reaches exactly 100% (FR-240 – FR-242)', async () => {
    const { learner, shortLessonId, longLessonId, previewLessonId, enrollmentOrderId } =
      await actors();
    const enrollment = await getEnrollment(enrollmentOrderId);

    const afterPreview = await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${previewLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    expect(afterPreview.body.is_completed).toBe(true);
    await expect(
      dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ id: enrollment.id }),
    ).resolves.toMatchObject({ progress_bps: 0 });

    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${shortLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await expect(
      dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ id: enrollment.id }),
    ).resolves.toMatchObject({ progress_bps: 5000 });

    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${longLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    const completed = await dataSource
      .getRepository(MarketplaceEnrollment)
      .findOneByOrFail({ id: enrollment.id });
    expect(completed.progress_bps).toBe(10000);
    expect(completed.completed_at).not.toBeNull();
  });

  it('issues exactly one verifiable certificate on completion, and it is publicly verifiable with no academic record behind it (FR-248, FR-324)', async () => {
    const { learner, shortLessonId, longLessonId, enrollmentOrderId } = await actors(true);
    const enrollment = await getEnrollment(enrollmentOrderId);

    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${shortLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${longLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await waitForListeners();

    const certificate = await dataSource
      .getRepository(Certificate)
      .findOneByOrFail({ student_id: learner.userId, marketplace_course_id: enrollment.course_id });
    expect(certificate).toMatchObject({
      source: 'marketplace',
      package_id: null,
      status: 'issued',
    });

    const verify = await learner.agent
      .get(`${API_PREFIX}/certificates/verify/${certificate.verification_code}`)
      .expect(200);
    expect(verify.body).toMatchObject({
      valid: true,
      certificate: expect.objectContaining({ course_title: expect.any(String) }),
    });
  });

  it('lists the certificate on GET /marketplace/me/certificates — the role-agnostic route a non-student marketplace learner needs (FR-252)', async () => {
    const { learner, shortLessonId, longLessonId, enrollmentOrderId } = await actors(true);
    const enrollment = await getEnrollment(enrollmentOrderId);
    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${shortLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${longLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await waitForListeners();

    const mine = await learner.agent.get(`${API_PREFIX}/marketplace/me/certificates`).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({
      source: 'marketplace',
      marketplace_course_id: enrollment.course_id,
    });
  });

  it('never issues a certificate for a course without certificates enabled', async () => {
    const { learner, shortLessonId, longLessonId, enrollmentOrderId } = await actors(false);
    const enrollment = await getEnrollment(enrollmentOrderId);

    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${shortLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${longLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await waitForListeners();

    expect(
      await dataSource
        .getRepository(Certificate)
        .countBy({ student_id: learner.userId, marketplace_course_id: enrollment.course_id }),
    ).toBe(0);
  });

  it('revokes the certificate when the enrollment is revoked, visible on public verification (FR-251)', async () => {
    const { learner, shortLessonId, longLessonId, enrollmentOrderId } = await actors(true);
    const enrollment = await getEnrollment(enrollmentOrderId);
    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${shortLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${longLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);
    await waitForListeners();
    const certificate = await dataSource
      .getRepository(Certificate)
      .findOneByOrFail({ student_id: learner.userId, marketplace_course_id: enrollment.course_id });

    // No admin/refund HTTP endpoint drives enrollment revocation yet (Phase 9/12) —
    // invoked directly here, matching the established e2e precedent of calling a
    // service method for an internal trigger that has no controller in front of it
    // yet (e.g. `payment-financial-state-machine.postgres.e2e-spec.ts`).
    const enrollmentService = app.get(EnrollmentService);
    await enrollmentService.revoke(enrollment.id, 'Refund completed');
    await waitForListeners();

    const verify = await learner.agent
      .get(`${API_PREFIX}/certificates/verify/${certificate.verification_code}`)
      .expect(200);
    expect(verify.body).toMatchObject({
      valid: false,
      certificate: expect.objectContaining({ status: 'revoked' }),
    });
  });

  it("lists the learner's own enrollments with the course eager-loaded for title/slug/cover display (FR-107, T129)", async () => {
    const { learner, course } = await actors();

    const list = await learner.agent.get(`${API_PREFIX}/marketplace/me/enrollments`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      course_id: course.id,
      course: expect.objectContaining({ id: course.id, title: course.title, slug: course.slug }),
    });
  });

  it('gives the player curriculum with completion state, and 404s a lesson from another course (T125)', async () => {
    const { learner, shortLessonId, enrollmentOrderId } = await actors();
    const enrollment = await getEnrollment(enrollmentOrderId);

    await learner.agent
      .put(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${shortLessonId}/progress`,
      )
      .send({ is_completed: true })
      .expect(200);

    const player = await learner.agent
      .get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/player`)
      .expect(200);
    expect(player.body.progress_bps).toBe(5000);
    const shortLessonInPlayer = player.body.sections[0].lessons.find(
      (l: { id: string }) => l.id === shortLessonId,
    );
    expect(shortLessonInPlayer).toMatchObject({ is_completed: true });

    await learner.agent
      .get(
        `${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/00000000-0000-4000-8000-000000000099`,
      )
      .expect(404);
  });

  it("404s the player for another learner's enrollment id (IDOR)", async () => {
    const { enrollmentOrderId } = await actors();
    const enrollment = await getEnrollment(enrollmentOrderId);
    const other = await createAuthenticatedUser(app, dataSource);

    await other.agent
      .get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/player`)
      .expect(404);
  });

  // T125's playback AC (a fresh, short-lived grant every request; a 404 rather
  // than ever returning a durable address for a video that is not an AWS
  // asset) is proven at the unit level in `player.service.spec.ts` instead of
  // here: course *submission* itself needs a ready AWS video asset for any
  // video-type lesson (`CourseReadinessService.allVideoLessonsReady`), which
  // this e2e environment cannot produce (matching the T065/T074/T077
  // precedent) — there is no way to get a video lesson through instructor
  // authoring here at all, let alone to its player.

  it('serves text lesson content directly through the signed-content endpoint (FR-084)', async () => {
    const { learner, shortLessonId, enrollmentOrderId } = await actors();
    const enrollment = await getEnrollment(enrollmentOrderId);

    const textContent = await learner.agent
      .get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${shortLessonId}`)
      .expect(200);
    expect(textContent.body).toMatchObject({
      content_type: 'text',
      playback_url: null,
      content_html: expect.stringContaining('Short'),
    });
  });
});
