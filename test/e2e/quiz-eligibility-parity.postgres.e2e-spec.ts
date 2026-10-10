import { randomUUID } from 'node:crypto';

import { QuizAnalyticsService } from '../../src/analytics/quiz-analytics.service';
import { AttemptState } from '../../src/exams/entities/attempt-state.enum';
import { createAuthenticatedUser, createE2EApp, resetDatabase, type E2EContext } from './fixtures';

/**
 * T098 / W1-C7(b): the teacher quiz eligibility summary no longer materialises every
 * (public exam x active student) pair. Parity against the pre-rewrite SQL (kept below as the
 * oracle) on a fixture where one student is eligible for the same exam through several paths,
 * plus inactive, soft-deleted and expired-access students and exams that are not yet open.
 */
const ORACLE_SQL = `
WITH eligible AS (
          SELECT exam.id AS exam_id, student.id AS student_id
          FROM exams exam
          INNER JOIN users student
            ON student.role = 'student'
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = true

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN package_purchases purchase
            ON purchase.package_id = exam.package_id
           AND purchase.revoked_at IS NULL
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.package_id IS NOT NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lesson_purchases purchase
            ON purchase.lesson_id = exam.lesson_id
           AND purchase.revoked_at IS NULL
           AND purchase.access_expires_at > NOW()
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NOT NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lesson_package_items item ON item.lesson_id = exam.lesson_id
          INNER JOIN package_purchases purchase
            ON purchase.package_id = item.package_id
           AND purchase.revoked_at IS NULL
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NOT NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lessons roster_lesson ON roster_lesson.teacher_id = exam.teacher_id
          INNER JOIN lesson_purchases purchase
            ON purchase.lesson_id = roster_lesson.id
           AND purchase.revoked_at IS NULL
           AND purchase.access_expires_at > NOW()
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NULL
            AND exam.package_id IS NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lesson_packages roster_course ON roster_course.teacher_id = exam.teacher_id
          INNER JOIN package_purchases purchase
            ON purchase.package_id = roster_course.id
           AND purchase.revoked_at IS NULL
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NULL
            AND exam.package_id IS NULL
        ), completed AS (
          SELECT DISTINCT attempt.exam_id, attempt.student_id
          FROM exam_attempts attempt
          INNER JOIN exams exam ON exam.id = attempt.exam_id
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND attempt.state = ANY($2)
            AND attempt.score_total IS NOT NULL
        )
        SELECT
          COUNT(*)::int AS "eligibleStudents",
          COUNT(completed.student_id)::int AS "completedStudents"
        FROM eligible
        LEFT JOIN completed
          ON completed.exam_id = eligible.exam_id
         AND completed.student_id = eligible.student_id
`;

interface Summary {
  eligibleStudents: number;
  completedStudents: number;
}

describe('teacher quiz eligibility summary parity (T098)', () => {
  let ctx: E2EContext;
  let service: QuizAnalyticsService;

  beforeAll(async () => {
    ctx = await createE2EApp();
    service = ctx.app.get(QuizAnalyticsService);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const q = (sql: string, params: unknown[] = []) =>
    ctx.dataSource.query(sql, params) as Promise<Array<Record<string, string>>>;

  async function oracle(teacherId: string): Promise<Summary> {
    const rows = (await ctx.dataSource.query(ORACLE_SQL, [
      teacherId,
      [AttemptState.SUBMITTED, AttemptState.GRADING, AttemptState.GRADED],
    ])) as Array<{ eligibleStudents: number | string; completedStudents: number | string }>;
    return {
      eligibleStudents: Number(rows[0]?.eligibleStudents ?? 0),
      completedStudents: Number(rows[0]?.completedStudents ?? 0),
    };
  }

  async function actual(teacherId: string): Promise<Summary> {
    return (
      service as unknown as { getTeacherEligibilitySummary(id: string): Promise<Summary> }
    ).getTeacherEligibilitySummary(teacherId);
  }

  async function exam(
    teacherId: string,
    subjectId: string,
    over: {
      status?: string;
      isPublic?: boolean;
      lessonId?: string;
      packageId?: string;
      start?: string;
    },
  ): Promise<string> {
    const rows = await q(
      `INSERT INTO exams (id, teacher_id, subject_id, title, title_ar, status, is_public, lesson_id, package_id, config, total_marks, passing_marks)
       VALUES (gen_random_uuid(), $1, $2, 'E', 'E', $3, $4, $5, $6, $7, 10, 5) RETURNING id`,
      [
        teacherId,
        subjectId,
        over.status ?? 'published',
        over.isPublic ?? false,
        over.lessonId ?? null,
        over.packageId ?? null,
        JSON.stringify(over.start ? { start_window_at: over.start } : {}),
      ],
    );
    return rows[0]!['id']!;
  }

  it('matches the pre-rewrite result on a multi-path fixture', async () => {
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    const other = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(
        (await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' })).userId,
      );
    }
    const [s1, s2, s3, s4, inactive, deleted] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [inactive]);
    await q(`UPDATE users SET deleted_at = now() WHERE id = $1`, [deleted]);

    const subjectId = (
      await q(`INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'T098') RETURNING id`)
    )[0]!['id']!;
    const newLesson = async (owner: string): Promise<string> =>
      (
        await q(
          `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version) VALUES (gen_random_uuid(), 'L', $1, $2, 0, 1) RETURNING id`,
          [owner, subjectId],
        )
      )[0]!['id']!;
    const newPackage = async (owner: string): Promise<string> =>
      (
        await q(
          `INSERT INTO lesson_packages (id, title, title_ar, teacher_id, price) VALUES (gen_random_uuid(), 'P', 'P', $1, 0) RETURNING id`,
          [owner],
        )
      )[0]!['id']!;

    const lessonA = await newLesson(teacher.userId);
    const lessonB = await newLesson(teacher.userId);
    const packageX = await newPackage(teacher.userId);
    const packageY = await newPackage(teacher.userId);
    await q(
      `INSERT INTO lesson_package_items (id, package_id, lesson_id) VALUES (gen_random_uuid(), $1, $2)`,
      [packageX, lessonA],
    );

    // FK enforcement is disabled on this one connection, only for the raw fixture inserts.
    const runner = ctx.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET session_replication_role = replica`);
      const pp = (student: string, pkg: string, revoked = false) =>
        runner.query(
          `INSERT INTO package_purchases (id, student_id, package_id, payment_id, price_paid, purchased_at, revoked_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 0, now(), $4)`,
          [student, pkg, randomUUID(), revoked ? new Date() : null],
        );
      const lp = (student: string, lesson: string, expired = false, revoked = false) =>
        runner.query(
          `INSERT INTO lesson_purchases (id, student_id, lesson_id, payment_id, price_paid, access_granted_at, access_expires_at, revoked_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 0, now(), $4, $5)`,
          [
            student,
            lesson,
            randomUUID(),
            new Date(Date.now() + (expired ? -1 : 1) * 86_400_000),
            revoked ? new Date() : null,
          ],
        );
      await pp(s1, packageX);
      await pp(s2, packageX);
      await pp(s3, packageX, true); // revoked
      await pp(s2, packageY); // roster course (the teacher owns packageY)
      await pp(s4, packageY);
      await pp(inactive, packageX);
      await lp(s2, lessonA); // overlaps with the package route through lessonA
      await lp(s3, lessonA, true); // expired
      await lp(s4, lessonB);
      await lp(deleted, lessonB);
      await lp(s1, lessonB, false, true); // revoked
    } finally {
      await runner.query(`SET session_replication_role = DEFAULT`);
      await runner.release();
    }

    const publicExam = await exam(teacher.userId, subjectId, { isPublic: true });
    await exam(teacher.userId, subjectId, { isPublic: true, status: 'draft' });
    await exam(teacher.userId, subjectId, { isPublic: true, start: '2999-01-01T00:00:00Z' });
    const packageExam = await exam(teacher.userId, subjectId, { packageId: packageX });
    const lessonExam = await exam(teacher.userId, subjectId, { lessonId: lessonA });
    const lessonExamB = await exam(teacher.userId, subjectId, { lessonId: lessonB });
    const rosterExam = await exam(teacher.userId, subjectId, {});
    await exam(other.userId, subjectId, { isPublic: true }); // another teacher

    const attempt = (
      examId: string,
      student: string,
      state: string,
      score: number | null,
      number = 1,
    ) =>
      q(
        `INSERT INTO exam_attempts (id, exam_id, student_id, attempt_number, started_at, deadline_at, session_token, state, score_total)
         VALUES (gen_random_uuid(), $1, $2, $5, now(), now(), gen_random_uuid(), $3, $4)`,
        [examId, student, state, score, number],
      );
    await attempt(publicExam, s1, 'graded', 8);
    await attempt(publicExam, s2, 'graded', 5);
    await attempt(publicExam, s2, 'submitted', 6, 2); // duplicate pair
    await attempt(publicExam, s3, 'in_progress', null); // not completed
    await attempt(publicExam, deleted, 'graded', 3); // completed by a soft-deleted student: not eligible
    await attempt(packageExam, s1, 'graded', 9);
    await attempt(lessonExam, s2, 'graded', 7);
    await attempt(lessonExamB, s4, 'graded', 4);
    await attempt(rosterExam, s4, 'graded', 2);
    await attempt(rosterExam, deleted, 'graded', 2); // completed by an ineligible student

    const expected = await oracle(teacher.userId);
    const result = await actual(teacher.userId);
    expect(expected.eligibleStudents).toBeGreaterThan(10);
    expect(expected.completedStudents).toBeGreaterThan(3);
    expect(result).toEqual(expected);

    const empty = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    expect(await actual(empty.userId)).toEqual(await oracle(empty.userId));
  });
});
