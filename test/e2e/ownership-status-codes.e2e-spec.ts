import type { DataSource } from 'typeorm';

import { Exam } from '../../src/exams/entities/exam.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

jest.setTimeout(180_000);

/**
 * Characterization of the EXACT status codes the per-service ownership checks return today
 * (SOLID audit, Phase 0). `horizontal-authorization.e2e-spec.ts` only asserts `403 | 404`; the
 * later ownership-helper consolidation (audit finding X-01) must not change these codes silently.
 * Where the current behavior is inconsistent (403 vs 404 across services) it is recorded here
 * as-is and called out, not endorsed. Soft-deleted lessons/exams are hidden from every
 * repository `find*` by their `@DeleteDateColumn`, so an explicit `deleted_at: IsNull()` in a
 * check is redundant rather than a behavioral difference.
 */
describe('teacher ownership status codes (e2e characterization)', () => {
  let ctx: E2EContext;
  const ds = (): DataSource => ctx.dataSource;
  const MISSING_ID = '00000000-0000-4000-8000-000000000000';

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ds()));
  afterAll(async () => ctx.app.close());

  async function seedSubject(): Promise<string> {
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'Ownership subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    return subject.id;
  }

  async function seedLesson(teacher: AuthenticatedUser, subjectId: string): Promise<string> {
    const lessons = ds().getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'Owned lesson',
        description: null,
        teacher_id: teacher.userId,
        subject_id: subjectId,
        thumbnail: null,
        price: 100,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    return lesson.id;
  }

  async function seedExam(teacher: AuthenticatedUser, subjectId: string): Promise<string> {
    const exams = ds().getRepository(Exam);
    const exam = await exams.save(
      exams.create({
        teacher_id: teacher.userId,
        subject_id: subjectId,
        lesson_id: null,
        package_id: null,
        title: 'Owned exam',
        title_ar: 'اختبار',
        description: null,
        description_ar: null,
        is_public: false,
        status: 'draft',
        config: {
          duration_seconds: 600,
          grace_seconds: 30,
          attempts_allowed: 1,
          review_policy: 'after_submit',
          shuffle_questions: false,
          shuffle_choices: false,
          start_window_at: null,
          end_window_at: null,
        },
        total_marks: 1,
        passing_marks: 1,
      } as never) as unknown as Exam,
    );
    return exam.id;
  }

  async function softDelete(table: 'lessons' | 'exams', id: string): Promise<void> {
    await ds().query(`UPDATE ${table} SET deleted_at = NOW() WHERE id = $1`, [id]);
  }

  describe('attendance controller (TeacherAttendanceController.validateOwnership)', () => {
    it('answers 403 for another teacher lesson AND for a lesson that does not exist', async () => {
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const other = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const lessonId = await seedLesson(owner, await seedSubject());

      const foreign = await other.agent.get(`${API_PREFIX}/teacher/lessons/${lessonId}/attendance`);
      const missing = await other.agent.get(
        `${API_PREFIX}/teacher/lessons/${MISSING_ID}/attendance`,
      );

      expect(foreign.status).toBe(403);
      expect(missing.status).toBe(403); // not-found is reported as 403 by this controller
    });

    it('treats a soft-deleted lesson as missing even for its owner (403)', async () => {
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const lessonId = await seedLesson(owner, await seedSubject());
      await softDelete('lessons', lessonId);

      const res = await owner.agent.get(`${API_PREFIX}/teacher/lessons/${lessonId}/attendance`);

      expect(res.status).toBe(403);
    });
  });

  describe('lesson sessions (LessonSessionsService.assertOwnedLesson)', () => {
    it('answers 403 for another teacher lesson and for a lesson that does not exist', async () => {
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const other = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const lessonId = await seedLesson(owner, await seedSubject());

      const foreign = await other.agent.get(`${API_PREFIX}/teacher/lessons/${lessonId}/sessions`);
      const missing = await other.agent.get(`${API_PREFIX}/teacher/lessons/${MISSING_ID}/sessions`);

      expect(foreign.status).toBe(403);
      expect(missing.status).toBe(403);
    });

    it('treats a soft-deleted lesson as missing for its owner (403, via implicit @DeleteDateColumn filtering)', async () => {
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const lessonId = await seedLesson(owner, await seedSubject());
      await softDelete('lessons', lessonId);

      const res = await owner.agent.get(`${API_PREFIX}/teacher/lessons/${lessonId}/sessions`);

      expect(res.status).toBe(403);
    });
  });

  describe('exam authoring (ExamAuthoringService.findOwned)', () => {
    it('answers 404 for another teacher exam and for an exam that does not exist', async () => {
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const other = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const examId = await seedExam(owner, await seedSubject());

      const foreign = await other.agent.get(`${API_PREFIX}/teacher/exams/${examId}`);
      const missing = await other.agent.get(`${API_PREFIX}/teacher/exams/${MISSING_ID}`);

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
    });

    it('treats a soft-deleted exam as missing for its owner (404)', async () => {
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const examId = await seedExam(owner, await seedSubject());
      await softDelete('exams', examId);

      const res = await owner.agent.get(`${API_PREFIX}/teacher/exams/${examId}`);

      expect(res.status).toBe(404);
    });
  });

  describe('lessons CRUD (LessonsService.findOwnedLesson)', () => {
    it('answers 403 for another teacher lesson but 404 for a lesson that does not exist', async () => {
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const other = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const lessonId = await seedLesson(owner, await seedSubject());

      const foreign = await other.agent
        .put(`${API_PREFIX}/teacher/lessons/${lessonId}`)
        .send({ title: 'Hijacked' });
      const missing = await other.agent
        .put(`${API_PREFIX}/teacher/lessons/${MISSING_ID}`)
        .send({ title: 'Hijacked' });

      expect(foreign.status).toBe(403);
      expect(missing.status).toBe(404); // differs from the foreign case: 403 vs 404 is inconsistent today
    });
  });
});
