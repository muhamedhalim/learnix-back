import { IsNull } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonProgress } from '../../src/lessons/entities/lesson-progress.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

/**
 * T060 (W3-C13 step 1): characterization of `GET /reports/student/progress`
 * BEFORE `getStudentProgressReport` is rewritten (T061). It pins what the
 * report does today, in particular how a progress row whose lesson is
 * SOFT-DELETED is treated (`progress.find({ relations: ['lesson'] })` joins
 * `lessons` with TypeORM's implicit `deleted_at IS NULL`, so `p.lesson` can be
 * undefined where `calculateAllSubjectProgress` dereferences it).
 *
 * The two groups are deliberately separate: the parity fixtures contain no
 * soft-deleted lesson, the soft-delete fixture records whatever is observed.
 */
describe('Student progress report characterization (postgres)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const url = `${API_PREFIX}/reports/student/progress`;

  async function teacher(): Promise<User> {
    const users = ctx.dataSource.getRepository(User);
    return users.save(
      users.create({
        username: 'spr-teacher',
        name: 'SPR Teacher',
        first_name: null,
        last_name: null,
        email: 'spr-teacher@example.test',
        phone: '01140000001',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function subject(name: string): Promise<Subject> {
    const subjects = ctx.dataSource.getRepository(Subject);
    return subjects.save(
      subjects.create({
        name,
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
  }

  async function lesson(teacherId: string, subjectId: string, title: string): Promise<Lesson> {
    const lessons = ctx.dataSource.getRepository(Lesson);
    return lessons.save(
      lessons.create({
        title,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: 0,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
  }

  async function progress(studentId: string, l: Lesson, completed: boolean): Promise<void> {
    const repo = ctx.dataSource.getRepository(LessonProgress);
    await repo.save(
      repo.create({
        student_id: studentId,
        lesson_id: l.id,
        watched_duration: 0,
        total_duration: 600,
        progress_percent: completed ? 100 : 20,
        completed,
        completed_at: completed ? new Date('2026-02-01T10:00:00Z') : null,
        last_watched_at: new Date('2026-02-01T10:00:00Z'),
      } as never),
    );
  }

  /** Two live subjects, three live lessons each; the student completed some. */
  async function liveFixture() {
    const owner = await teacher();
    const math = await subject('Mathematics');
    const physics = await subject('Physics');
    const m1 = await lesson(owner.id, math.id, 'M1');
    const m2 = await lesson(owner.id, math.id, 'M2');
    const m3 = await lesson(owner.id, math.id, 'M3');
    const p1 = await lesson(owner.id, physics.id, 'P1');
    const p2 = await lesson(owner.id, physics.id, 'P2');
    const p3 = await lesson(owner.id, physics.id, 'P3');
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    await progress(student.userId, m1, true);
    await progress(student.userId, m2, true);
    await progress(student.userId, m3, false);
    await progress(student.userId, p1, true);
    await progress(student.userId, p2, false);
    return { student, owner, math, physics, m1, m2, m3, p1, p2, p3 };
  }

  describe('without soft-deleted lessons (parity fixtures for T061)', () => {
    it('returns the full report JSON pinned as-is, subjects in repository order', async () => {
      const { student, math, physics } = await liveFixture();

      const response = await student.agent.get(url).expect(200);
      const report = (response.body.data ?? response.body) as {
        overallProgress: number;
        subjects: Array<Record<string, unknown>>;
        strengths: string[];
        needsImprovement: string[];
      };

      const bySubject = new Map(report.subjects.map((s) => [s['subjectId'], s]));
      expect(bySubject.get(math.id)).toEqual({
        subjectId: math.id,
        subjectName: 'Mathematics',
        lessonsCompleted: 2,
        lessonsTotal: 3,
        averageScore: null,
        progressPercent: 67,
      });
      expect(bySubject.get(physics.id)).toEqual({
        subjectId: physics.id,
        subjectName: 'Physics',
        lessonsCompleted: 1,
        lessonsTotal: 3,
        averageScore: null,
        progressPercent: 33,
      });
      expect(report.subjects).toHaveLength(2);
      expect(report.overallProgress).toBe(50);
      // The order is the subjects repository's own (T061 keeps that query), recorded here.
      const repositoryOrder = (
        await ctx.dataSource.getRepository(Subject).find({ where: { deleted_at: IsNull() } })
      ).map((s) => s.name);
      expect(report.subjects.map((s) => s['subjectName'])).toEqual(repositoryOrder);
    });

    it('a student with no progress gets zeros for every subject', async () => {
      await liveFixture();
      const lonely = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const response = await lonely.agent.get(url).expect(200);
      const report = (response.body.data ?? response.body) as {
        subjects: Array<{ lessonsCompleted: number; progressPercent: number }>;
      };
      expect(report.subjects.every((s) => s.lessonsCompleted === 0 && s.progressPercent === 0)).toBe(true);
    });
  });

  describe('soft-deleted lesson (T061 regression: excluded, never a 500)', () => {
    it('completed progress on a soft-deleted lesson is not counted and does not fail the report', async () => {
      const { student, owner, math, physics } = await liveFixture();
      const doomed = await lesson(owner.id, math.id, 'M-deleted');
      await progress(student.userId, doomed, true);
      await ctx.dataSource.getRepository(Lesson).softDelete({ id: doomed.id });

      const response = await student.agent.get(url).expect(200);
      const report = (response.body.data ?? response.body) as {
        overallProgress: number;
        subjects: Array<Record<string, unknown>>;
      };

      // T060 recorded the pre-rewrite behaviour: HTTP 500 (TypeError on `p.lesson.subject_id`).
      // After T061 the soft-deleted lesson is excluded and every figure equals the live-only fixture.
      const bySubject = new Map(report.subjects.map((s) => [s['subjectId'], s]));
      expect(bySubject.get(math.id)).toMatchObject({ lessonsCompleted: 2, lessonsTotal: 3, progressPercent: 67 });
      expect(bySubject.get(physics.id)).toMatchObject({ lessonsCompleted: 1, lessonsTotal: 3, progressPercent: 33 });
      expect(report.overallProgress).toBe(50);
    });
  });
});
