import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import request from 'supertest';

import { ApplicationCacheService } from '../../src/common/cache/application-cache.service';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { LessonContentType } from '../../src/marketplace/common/enums';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { Notification } from '../../src/notifications/entities/notification.entity';
import { NotificationStatus } from '../../src/notifications/entities/notification-status.enum';
import { NotificationType } from '../../src/notifications/entities/notification-type.enum';
import { buildInstructorFixture } from './factories/marketplace.factory';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';
import { createEnrolledStudent } from './helpers/enrolled-student';
import { TEST_IMAGE_KEY, TEST_IMAGE_KEY_2 } from './helpers/images';

/**
 * Wave 1 (T030, T031, T032, T035): which cache-invalidation call each kind of
 * mutating route makes, observed on the REAL `ApplicationCacheService` that the
 * global `CacheInvalidationInterceptor` uses.
 *
 * The three public invalidation methods are spied with call-through, so the
 * generation really advances (the behavioural half is asserted in
 * `marketplace-catalog-cache.e2e-spec.ts`); this suite asserts the *declaration
 * contract*: exempted routes call none of them, an undeclared mutation still
 * calls `invalidateAll` exactly once, a declared route calls `invalidate` with
 * exactly its declared families and never `invalidateAll`, a `self` target
 * resolves to the caller's own `owner:<userId>` slice, and a handler error
 * never invalidates.
 *
 * Fixture setup (registering users, seeding rows over HTTP) legitimately
 * invalidates, so every test clears the spies immediately before the single
 * request under test.
 */
describe('cache invalidation declarations (e2e, T030/T031/T032/T035)', () => {
  let ctx: E2EContext;
  let server: Server;
  let spies: ReturnType<typeof installSpies>;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
    spies = installSpies(ctx.app.get(ApplicationCacheService));
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));

  afterAll(async () => {
    spies.all.mockRestore();
    spies.families.mockRestore();
    spies.scopes.mockRestore();
    await ctx.app.close();
  });

  function installSpies(cache: ApplicationCacheService) {
    return {
      all: jest.spyOn(cache, 'invalidateAll'),
      families: jest.spyOn(cache, 'invalidate'),
      scopes: jest.spyOn(cache, 'invalidateScopes'),
    };
  }

  function clearSpies(): void {
    spies.all.mockClear();
    spies.families.mockClear();
    spies.scopes.mockClear();
  }

  function expectNoInvalidation(): void {
    expect(spies.all).not.toHaveBeenCalled();
    expect(spies.families).not.toHaveBeenCalled();
    expect(spies.scopes).not.toHaveBeenCalled();
  }

  /** The family set of each `invalidate(...)` call, sorted so declaration order never matters. */
  function invalidatedFamilySets(): string[][] {
    return spies.families.mock.calls.map(([families]) => [...(families ?? [])].sort());
  }

  async function createTeacher(): Promise<AuthenticatedUser> {
    return createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
  }

  async function createTeacherSubject(teacher: AuthenticatedUser): Promise<string> {
    const res = await teacher.agent
      .post(`${API_PREFIX}/teacher/subjects`)
      .send({ name: `Declarations subject ${randomUUID()}` })
      .expect(201);
    return (res.body as { subject: { id: string } }).subject.id;
  }

  describe('exempted routes (@SkipCacheInvalidation) call none of invalidateAll / invalidate / invalidateScopes', () => {
    it('POST /auth/login', async () => {
      const user = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      clearSpies();

      await request(server)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: user.credentials.email, password: user.credentials.password })
        .expect(200);

      expectNoInvalidation();
    });

    it('POST /auth/refresh (rotating the refresh cookie)', async () => {
      const user = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      clearSpies();

      // Same cookie flow as auth.e2e-spec.ts: the agent carries the HttpOnly refresh cookie.
      await user.agent.post(`${API_PREFIX}/auth/refresh`).expect(200);

      expectNoInvalidation();
    });

    it('POST /auth/logout', async () => {
      const user = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      clearSpies();

      await user.agent.post(`${API_PREFIX}/auth/logout`).expect(200);

      expectNoInvalidation();
    });

    it('POST /notifications/:id/read', async () => {
      const user = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const notifications = ctx.dataSource.getRepository(Notification);
      const notification = await notifications.save(
        notifications.create({
          user_id: user.userId,
          type: NotificationType.CUSTOM,
          title: 'Cache declaration probe',
          message: 'Marking this read must not touch any cache generation.',
          sent_at: new Date(),
          status: NotificationStatus.SENT,
        }),
      );
      clearSpies();

      await user.agent.post(`${API_PREFIX}/notifications/${notification.id}/read`).expect(201);

      // The handler really ran (the write happened) — it just declared no cache dependency.
      await expect(notifications.findOneByOrFail({ id: notification.id })).resolves.toMatchObject({
        is_read: true,
      });
      expectNoInvalidation();
    });

    it('POST /notifications/read-all', async () => {
      const user = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const notifications = ctx.dataSource.getRepository(Notification);
      const notification = await notifications.save(
        notifications.create({
          user_id: user.userId,
          type: NotificationType.CUSTOM,
          title: 'Cache declaration probe',
          message: 'Marking all read must not touch any cache generation.',
          sent_at: new Date(),
          status: NotificationStatus.SENT,
        }),
      );
      clearSpies();

      await user.agent.post(`${API_PREFIX}/notifications/read-all`).expect(201);

      await expect(notifications.findOneByOrFail({ id: notification.id })).resolves.toMatchObject({
        is_read: true,
      });
      expectNoInvalidation();
    });
  });

  describe('undeclared mutations keep the global fallback', () => {
    it('POST /teacher/lessons calls invalidateAll exactly once and no family or scope invalidation', async () => {
      const teacher = await createTeacher();
      const subjectId = await createTeacherSubject(teacher);
      clearSpies();

      await teacher.agent
        .post(`${API_PREFIX}/teacher/lessons`)
        .send({ title: 'Undeclared write', subject_id: subjectId, price: 0, is_group: true })
        .expect(201);

      expect(spies.all).toHaveBeenCalledTimes(1);
      expect(spies.families).not.toHaveBeenCalled();
      expect(spies.scopes).not.toHaveBeenCalled();
    });

    it('a failing undeclared mutation (404) invalidates nothing', async () => {
      const owner = await createTeacher();
      const other = await createTeacher();
      const subjectId = await createTeacherSubject(owner);
      clearSpies();

      // Another teacher's pending subject is invisible to `other`: the handler throws 404.
      await other.agent
        .post(`${API_PREFIX}/teacher/lessons`)
        .send({ title: 'Borrowed lesson', subject_id: subjectId, price: 0, is_group: true })
        .expect(404);

      expectNoInvalidation();
    });
  });

  describe('declared marketplace catalogue routes (@InvalidatesCache)', () => {
    async function seedInstructor(): Promise<AuthenticatedUser> {
      const user = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      await ctx.dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: user.userId }));
      return user;
    }

    async function seedCategory(): Promise<MarketplaceCategory> {
      return ctx.dataSource.getRepository(MarketplaceCategory).save({
        name_en: 'Programming',
        name_ar: 'البرمجة',
        slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        display_order: 1,
      });
    }

    function courseBody(categoryId: string, priceMinor: number): Record<string, unknown> {
      return {
        title: `Declarations Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'Cache declaration coverage',
        description: 'A full description of the course content.',
        category_id: categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: priceMinor,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['n/a'],
      };
    }

    async function createDraftCourse(
      instructor: AuthenticatedUser,
      categoryId: string,
    ): Promise<string> {
      const created = await instructor.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses`)
        .send(courseBody(categoryId, 100_000))
        .expect(201);
      return (created.body as { id: string }).id;
    }

    /** Draft → sections/lessons → submit → admin approve → instructor publish (same flow as marketplace-catalog-cache). */
    async function publishFreeCourse(
      instructor: AuthenticatedUser,
      admin: AuthenticatedUser,
      categoryId: string,
    ): Promise<string> {
      const created = await instructor.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses`)
        .send(courseBody(categoryId, 0))
        .expect(201);
      const courseId = (created.body as { id: string }).id;
      const section = await instructor.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
        .send({ title: 'Getting Started' })
        .expect(201);
      for (let i = 0; i < 3; i++) {
        await instructor.agent
          .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
          .send({
            section_id: (section.body as { id: string }).id,
            title: `Lesson ${i + 1}`,
            content_type: LessonContentType.TEXT,
            content_html: `<p>Content ${i + 1}</p>`,
            duration_seconds: 120,
            is_free_preview: i === 0,
          })
          .expect(201);
      }
      await instructor.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
        .send({})
        .expect(201);
      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
        .send({})
        .expect(201);
      await instructor.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
        .send({})
        .expect(201);
      await expect(
        ctx.dataSource.getRepository(MarketplaceCourse).findOneByOrFail({ id: courseId }),
      ).resolves.toMatchObject({ status: 'published' });
      return courseId;
    }

    it('PATCH /marketplace/instructor/courses/:id calls invalidate with exactly [marketplace_catalog] — never invalidateAll', async () => {
      const instructor = await seedInstructor();
      const category = await seedCategory();
      const courseId = await createDraftCourse(instructor, category.id);
      clearSpies();

      await instructor.agent
        .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
        .send({ cover_image_key: TEST_IMAGE_KEY_2 })
        .expect(200);

      expect(invalidatedFamilySets()).toEqual([['marketplace_catalog']]);
      expect(spies.all).not.toHaveBeenCalled();
      expect(spies.scopes).not.toHaveBeenCalled();
    });

    it('POST /marketplace/checkout/enroll-free calls invalidate with exactly its three declared families — never invalidateAll', async () => {
      const instructor = await seedInstructor();
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const learner = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const category = await seedCategory();
      const courseId = await publishFreeCourse(instructor, admin, category.id);
      clearSpies();

      await learner.agent
        .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
        .send({ courseId })
        .expect(201);

      expect(invalidatedFamilySets()).toEqual([
        ['admin_dashboard', 'marketplace_catalog', 'platform_report'],
      ]);
      expect(spies.all).not.toHaveBeenCalled();
      expect(spies.scopes).not.toHaveBeenCalled();
    });

    it('a failing declared route (another instructor patching a course they do not own, 404) invalidates nothing', async () => {
      const owner = await seedInstructor();
      const other = await seedInstructor();
      const category = await seedCategory();
      const courseId = await createDraftCourse(owner, category.id);
      clearSpies();

      await other.agent
        .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
        .send({ title: 'Hijacked' })
        .expect(404);

      expectNoInvalidation();
    });
  });

  describe('owner-scoped declaration: POST /student/lessons/:lessonId/progress (@InvalidatesCache self)', () => {
    it('calls invalidateScopes with exactly [{ student_report, owner:<studentId> }, { student_quiz_analytics, owner:<studentId> }] and nothing else', async () => {
      const { student, lesson } = await createEnrolledStudent(ctx.app, ctx.dataSource);
      clearSpies();

      const res = await student.agent
        .post(`${API_PREFIX}/student/lessons/${lesson.id}/progress`)
        .send({ watchedDuration: 60 });
      expect([200, 201]).toContain(res.status);

      // `self` is resolved from the authenticated principal only — never from the URL or body.
      // T040: `lesson_progress` also feeds the owner's own `student_quiz_analytics` performance insights.
      expect(spies.scopes).toHaveBeenCalledTimes(1);
      expect(spies.scopes).toHaveBeenCalledWith([
        { family: 'student_report', scope: `owner:${student.userId}` },
        { family: 'student_quiz_analytics', scope: `owner:${student.userId}` },
      ]);
      expect(spies.all).not.toHaveBeenCalled();
      expect(spies.families).not.toHaveBeenCalled();
    });

    it('invalidates nothing when the handler rejects the write (no lesson access, 403)', async () => {
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      clearSpies();

      const res = await student.agent
        .post(`${API_PREFIX}/student/lessons/${randomUUID()}/progress`)
        .send({ watchedDuration: 60 });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      expectNoInvalidation();
    });
  });
});
