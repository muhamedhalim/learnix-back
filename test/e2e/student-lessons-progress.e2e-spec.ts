import type { Server } from 'node:http';

import request from 'supertest';

import { ApplicationCacheService } from '../../src/common/cache/application-cache.service';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

/** The supertest agent carried by an authenticated fixture user. */
type AuthenticatedAgent = AuthenticatedUser['agent'];

/**
 * Regression coverage for the student lesson-progress routes' registration
 * order. `GET /student/lessons/my/progress` is a static path that must be
 * matched before the dynamic `GET /student/lessons/:lessonId/progress` route
 * — otherwise NestJS/Express treat "my" as `:lessonId` and `ParseUUIDPipe`
 * rejects it with 400 before the controller method ever runs.
 */
describe('Student lesson progress routing (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('GET /student/lessons/my/progress does not get captured by the :lessonId route', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'student',
    });

    const res = await agent.get(`${API_PREFIX}/student/lessons/my/progress`).expect(200);

    expect(res.body).toEqual({ data: [] });
  });

  it('GET /student/lessons/:lessonId/progress still validates the id as a UUID', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'student',
    });

    await agent.get(`${API_PREFIX}/student/lessons/not-a-uuid/progress`).expect(400);
  });

  /**
   * Spec 004 T032 / T035 (additive): `POST student/lessons/:lessonId/progress` declares
   * `{ student_report, self }`, so the writer's own `GET /reports/student/progress` is fresh on the
   * next request (no TTL wait) while every other student's cached report is left alone.
   */
  describe('progress write and the cached student progress report (spec 004 T032/T035)', () => {
    interface ProgressReport {
      overallProgress: number;
      subjects: {
        subjectId: string;
        lessonsCompleted: number;
        lessonsTotal: number;
        progressPercent: number;
      }[];
    }

    const LESSON_SECONDS = 100;

    /** One teacher-owned lesson in one subject, plus an active purchase so `student` may record progress. */
    async function seedLesson(teacherId: string): Promise<{ lessonId: string; subjectId: string }> {
      const [{ id: subjectId }] = (await ctx.dataSource.query(
        `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Progress Cache Subject') RETURNING id`,
      )) as [{ id: string }];
      const [{ id: lessonId }] = (await ctx.dataSource.query(
        `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version) VALUES (gen_random_uuid(), 'Progress Cache Lesson', $1, $2, 100, 1) RETURNING id`,
        [teacherId, subjectId],
      )) as [{ id: string }];
      return { lessonId, subjectId };
    }

    async function grantLessonAccess(studentId: string, lessonId: string): Promise<void> {
      const [{ id: paymentId }] = (await ctx.dataSource.query(
        `INSERT INTO payments (id, user_id, item_type, item_id, amount, final_amount, idempotency_key)
         VALUES (gen_random_uuid(), $1, 'lesson', $2, 100, 100, $3) RETURNING id`,
        [studentId, lessonId, `idem-${studentId}-${lessonId}`],
      )) as [{ id: string }];
      await ctx.dataSource.query(
        `INSERT INTO lesson_purchases (id, student_id, lesson_id, payment_id, price_paid, access_granted_at, access_expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 100, now(), now() + interval '30 days')`,
        [studentId, lessonId, paymentId],
      );
    }

    async function readReport(agent: AuthenticatedAgent): Promise<ProgressReport> {
      const res = await agent.get(`${API_PREFIX}/reports/student/progress`).expect(200);
      return (res.body as { data: ProgressReport }).data;
    }

    async function completeLesson(agent: AuthenticatedAgent, lessonId: string): Promise<void> {
      await agent
        .post(`${API_PREFIX}/student/lessons/${lessonId}/progress`)
        .send({ watchedDuration: LESSON_SECONDS, totalDuration: LESSON_SECONDS })
        .expect(201);
    }

    /** First completion emits `lesson.completed` (async listeners); let them finish before the next truncate. */
    async function letAsyncListenersSettle(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    it('POST /student/lessons/:lessonId/progress is reflected by the very next GET /reports/student/progress', async () => {
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'teacher',
        overrides: { requestedRole: 'teacher' },
      });
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });
      const { lessonId, subjectId } = await seedLesson(teacher.userId);
      await grantLessonAccess(student.userId, lessonId);

      // Warm the report: one lesson in the subject, none completed.
      const warm = await readReport(student.agent);
      expect(warm.subjects.find((s) => s.subjectId === subjectId)).toMatchObject({
        lessonsTotal: 1,
        lessonsCompleted: 0,
        progressPercent: 0,
      });
      expect(await readReport(student.agent)).toEqual(warm);

      await completeLesson(student.agent, lessonId);

      // No TTL wait: the next request already shows the completed lesson.
      const fresh = await readReport(student.agent);
      expect(fresh.subjects.find((s) => s.subjectId === subjectId)).toMatchObject({
        lessonsTotal: 1,
        lessonsCompleted: 1,
        progressPercent: 100,
      });
      expect(fresh.overallProgress).toBe(100);

      await letAsyncListenersSettle();
    });

    it("a progress write refreshes only the writer's report: another student's cached report is untouched, and only { student_report, owner:<writer> } (plus student_quiz_analytics, T040) is invalidated", async () => {
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'teacher',
        overrides: { requestedRole: 'teacher' },
      });
      const studentA = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });
      const studentB = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });
      const { lessonId, subjectId } = await seedLesson(teacher.userId);
      await grantLessonAccess(studentA.userId, lessonId);

      const warmA = await readReport(studentA.agent);
      const warmB = await readReport(studentB.agent);
      expect(warmB.subjects.find((s) => s.subjectId === subjectId)?.lessonsCompleted).toBe(0);

      // Change B's data behind the cache's back: B has completed the lesson in the database.
      await ctx.dataSource.query(
        `INSERT INTO lesson_progress (id, student_id, lesson_id, watched_duration, total_duration, progress_percent, completed, completed_at, last_watched_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $3, 100, true, now(), now())`,
        [studentB.userId, lessonId, LESSON_SECONDS],
      );

      const cache = ctx.app.get(ApplicationCacheService);
      const invalidateAll = jest.spyOn(cache, 'invalidateAll');
      const invalidate = jest.spyOn(cache, 'invalidate');
      const invalidateScopes = jest.spyOn(cache, 'invalidateScopes');
      try {
        await completeLesson(studentA.agent, lessonId);

        expect(invalidateAll).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
        expect(invalidateScopes.mock.calls).toEqual([
          [
            [
              { family: 'student_report', scope: `owner:${studentA.userId}` },
              { family: 'student_quiz_analytics', scope: `owner:${studentA.userId}` },
            ],
          ],
        ]);
      } finally {
        jest.restoreAllMocks();
      }

      // A is fresh...
      const freshA = await readReport(studentA.agent);
      expect(freshA).not.toEqual(warmA);
      expect(freshA.subjects.find((s) => s.subjectId === subjectId)?.lessonsCompleted).toBe(1);

      // ...B's cached report is exactly what was cached, still ignoring the bypass write.
      expect(await readReport(studentB.agent)).toEqual(warmB);

      // Control: bumping only B's own slice reveals the bypass write.
      await cache.invalidateScopes([
        { family: 'student_report', scope: `owner:${studentB.userId}` },
      ]);
      expect(
        (await readReport(studentB.agent)).subjects.find((s) => s.subjectId === subjectId)
          ?.lessonsCompleted,
      ).toBe(1);

      await letAsyncListenersSettle();
    });
  });
});
