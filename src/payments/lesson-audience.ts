/**
 * The "who currently has access to this lesson" audience, in ONE place (T075 / W4-C10, G-019).
 *
 * Three call sites used to carry three slightly different copies of the rule: the exam
 * notification fan-out, the homework notification / submission list, and the teacher
 * follow-up homework statistics. The rules below are the owner's decisions recorded in
 * `specs/004-api-db-efficiency-audit/gates/W4-C10.md`:
 *
 * - **Exam notifications** mirror the student-side access check
 *   (`ExamAccessService.privateAudienceSql`), kind by kind, so that
 *   *a student who cannot open an exam never receives its notification*:
 *   public exam -> nobody; lesson exam -> a live direct lesson purchase only (a package never
 *   bypasses the lesson's own access window, because package access exists only as materialised
 *   per-lesson purchase rows); package exam -> an unrevoked package purchase; an exam with
 *   neither -> the teacher-roster rule.
 * - **Homework notifications** keep their separate decision (e): direct lesson purchases only.
 * - **Homework statistics** keep today's shape (lesson purchase OR package purchase) and are
 *   exposed here as a SQL predicate so the text lives with the other rules.
 *
 * Deliberately DI-free: the exams, lessons and teacher-follow-up modules all need it, and none of
 * them may depend on the payments module's providers (that would create import cycles).
 */

/** Anything that can run a parameterised statement: an `EntityManager`, a `DataSource`, a repository's manager. */
export interface AudienceRunner {
  query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
}

/** The audience-defining columns of an exam. */
export interface ExamAudienceTarget {
  is_public: boolean;
  lesson_id: string | null;
  package_id: string | null;
  teacher_id: string;
}

const studentIds = (rows: unknown): string[] =>
  (rows as Array<{ student_id: string }>).map((row) => row.student_id);

/**
 * Students to notify about `exam`: exactly those who can open it right now. Distinct ids; no
 * multiplication when a student holds several purchases. `now` is the application clock, the same
 * instant the access check binds.
 */
export async function examAudienceStudentIds(
  runner: AudienceRunner,
  exam: ExamAudienceTarget,
  now: Date,
): Promise<string[]> {
  // (0) Public practice content is not a private notification surface.
  if (exam.is_public) return [];

  // The three kinds are mutually exclusive in practice (the authoring service forbids a lesson AND a
  // package), but the access check ORs its branches, so this does too.
  const found = new Set<string>();

  // (a) Lesson exam: a live, unexpired DIRECT purchase of that lesson. No package branch.
  if (exam.lesson_id !== null) {
    for (const id of studentIds(
      await runner.query(
        `SELECT DISTINCT lp.student_id
           FROM lesson_purchases lp
          WHERE lp.lesson_id = $1
            AND lp.revoked_at IS NULL
            AND lp.access_expires_at > $2`,
        [exam.lesson_id, now],
      ),
    )) {
      found.add(id);
    }
  }

  // (b) Package exam: an unrevoked purchase of that package (it has no expiry of its own).
  if (exam.package_id !== null) {
    for (const id of studentIds(
      await runner.query(
        `SELECT DISTINCT pp.student_id
           FROM package_purchases pp
          WHERE pp.package_id = $1
            AND pp.revoked_at IS NULL`,
        [exam.package_id],
      ),
    )) {
      found.add(id);
    }
  }

  // (c) Neither: the teacher-roster rule the access check applies — a live lesson purchase on one of
  // this teacher's lessons, or an unrevoked purchase of one of this teacher's packages.
  if (exam.lesson_id === null && exam.package_id === null) {
    for (const id of studentIds(
      await runner.query(
        `SELECT lp.student_id
           FROM lesson_purchases lp
           INNER JOIN lessons roster_lesson ON roster_lesson.id = lp.lesson_id
          WHERE roster_lesson.teacher_id = $1
            AND lp.revoked_at IS NULL
            AND lp.access_expires_at > $2
         UNION
         SELECT pp.student_id
           FROM package_purchases pp
           INNER JOIN lesson_packages roster_package ON roster_package.id = pp.package_id
          WHERE roster_package.teacher_id = $1
            AND pp.revoked_at IS NULL`,
        [exam.teacher_id, now],
      ),
    )) {
      found.add(id);
    }
  }

  return [...found];
}

/**
 * Students to notify about, or list under, a lesson's homework (decision (e) in W4-C10): live
 * DIRECT lesson purchases only. Package-derived access is not included here.
 */
export async function homeworkAudienceStudentIds(
  runner: AudienceRunner,
  lessonId: string,
  now: Date,
): Promise<string[]> {
  return studentIds(
    await runner.query(
      `SELECT DISTINCT lp.student_id
         FROM lesson_purchases lp
        WHERE lp.lesson_id = $1
          AND lp.revoked_at IS NULL
          AND lp.access_expires_at > $2`,
      [lessonId, now],
    ),
  );
}

/**
 * The audience predicate of the teacher follow-up homework statistics, as SQL text to embed (today's
 * rule, unchanged by decision (e)): the student holds a live lesson purchase of the homework's lesson,
 * or an unrevoked purchase of a package that contains it. Uses the database clock as it always did.
 */
export function homeworkStatsAudienceSql(studentRef: string, homeworkRef: string): string {
  return `
          EXISTS (
            SELECT 1 FROM lesson_purchases lp
            WHERE lp.student_id = ${studentRef}.id
              AND lp.lesson_id = ${homeworkRef}.lesson_id
              AND lp.revoked_at IS NULL
              AND lp.access_expires_at > NOW()
          ) OR EXISTS (
            SELECT 1 FROM package_purchases pp
            INNER JOIN lesson_package_items item ON item.package_id = pp.package_id
            WHERE pp.student_id = ${studentRef}.id AND item.lesson_id = ${homeworkRef}.lesson_id
              AND pp.revoked_at IS NULL
          )`;
}
