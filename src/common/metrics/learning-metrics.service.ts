import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import type {
  LessonEngagementMetrics,
  PackageEngagementMetrics,
  StudentLearningMetrics,
} from './metrics.types';

interface CountRow {
  count: string | null;
}

interface LessonEngagementRow {
  students_with_access: string;
  students_with_active_access: string;
  students_completed: string;
}

interface PackageEngagementRow {
  students_with_access: string;
  purchase_rows: string;
  purchased_version_count: string;
}

interface StudentLearningRow {
  lessons_purchased: string;
  lessons_completed: string;
  courses_purchased: string;
  exams_completed: string;
  average_score_percent: string | null;
}

interface LessonStudentCountRow {
  lesson_id: string;
  count: string;
}

/**
 * The canonical read-model for non-financial "how much learning happened"
 * numbers: who holds access to a product, who finished it, and how a student is
 * doing overall.
 *
 * ## Why `lesson_purchases` is the access source
 * `PaymentFinalizationService` writes a `lesson_purchases` row both for a direct
 * lesson sale and for every lesson inside a purchased course. It is therefore
 * the only table that answers "which students can actually open this lesson",
 * and it is what the entitlement checks read at playback time. Counting
 * `orders` instead would miss every student who got the lesson in a bundle.
 *
 * ## Revoked vs expired
 * `revoked_at` is set when access is withdrawn — notably by
 * `RefundsService.revokeAccess` on a **full** refund. Revoked rows are excluded
 * everywhere below. Expiry (`access_expires_at`) is different: the student did
 * buy and did have access, so they stay in `students_with_access` and are
 * reported separately as `students_with_active_access`.
 */
@Injectable()
export class LearningMetricsService {
  public constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Access and completion for a single lesson. */
  public async getLessonEngagementMetrics(lessonId: string): Promise<LessonEngagementMetrics> {
    const rows = await this.dataSource.query<LessonEngagementRow[]>(
      `SELECT
         (SELECT COUNT(DISTINCT lp.student_id)
            FROM lesson_purchases lp
           WHERE lp.lesson_id = $1 AND lp.revoked_at IS NULL)::text AS students_with_access,
         (SELECT COUNT(DISTINCT lp.student_id)
            FROM lesson_purchases lp
           WHERE lp.lesson_id = $1 AND lp.revoked_at IS NULL
             AND lp.access_expires_at > now())::text AS students_with_active_access,
         (SELECT COUNT(DISTINCT pr.student_id)
            FROM lesson_progress pr
           WHERE pr.lesson_id = $1 AND pr.completed = true)::text AS students_completed`,
      [lessonId],
    );
    const row = rows[0];
    return {
      students_with_access: this.toInt(row?.students_with_access),
      students_with_active_access: this.toInt(row?.students_with_active_access),
      students_completed: this.toInt(row?.students_completed),
    };
  }

  /**
   * Access for a single course, aggregated across **every** version of it.
   *
   * Course identity is `package_purchases.package_id`; `course_version_id`
   * records which immutable curriculum snapshot was bought (see
   * `CourseVersion`). A student who re-bought after the teacher published a new
   * version therefore has two rows but is one student — hence
   * `COUNT(DISTINCT student_id)` for `students_with_access` and a separate
   * `purchase_rows` for the raw row count.
   */
  public async getPackageEngagementMetrics(packageId: string): Promise<PackageEngagementMetrics> {
    const rows = await this.dataSource.query<PackageEngagementRow[]>(
      `SELECT
         COUNT(DISTINCT pp.student_id)::text AS students_with_access,
         COUNT(*)::text AS purchase_rows,
         COUNT(DISTINCT pp.course_version_id)::text AS purchased_version_count
       FROM package_purchases pp
       WHERE pp.package_id = $1 AND pp.revoked_at IS NULL`,
      [packageId],
    );
    const row = rows[0];
    return {
      students_with_access: this.toInt(row?.students_with_access),
      purchase_rows: this.toInt(row?.purchase_rows),
      purchased_version_count: this.toInt(row?.purchased_version_count),
    };
  }

  /**
   * Everything the student-facing and admin student stats need, in one round
   * trip.
   *
   * @param studentUserId `users.id` — **not** `student_profiles.id`. Every table
   *   read here keys on the user id; callers holding a profile must resolve
   *   `profile.user_id` first.
   */
  public async getStudentLearningMetrics(studentUserId: string): Promise<StudentLearningMetrics> {
    const rows = await this.dataSource.query<StudentLearningRow[]>(
      `SELECT
         (SELECT COUNT(DISTINCT lp.lesson_id)
            FROM lesson_purchases lp
           WHERE lp.student_id = $1 AND lp.revoked_at IS NULL)::text AS lessons_purchased,
         (SELECT COUNT(DISTINCT pr.lesson_id)
            FROM lesson_progress pr
           WHERE pr.student_id = $1 AND pr.completed = true)::text AS lessons_completed,
         (SELECT COUNT(DISTINCT pp.package_id)
            FROM package_purchases pp
           WHERE pp.student_id = $1 AND pp.revoked_at IS NULL)::text AS courses_purchased,
         (SELECT COUNT(*)
            FROM exam_attempts ea
           WHERE ea.student_id = $1 AND ea.state = 'graded')::text AS exams_completed,
         (SELECT ROUND(AVG(ea.score_total / ea.max_score * 100), 2)
            FROM exam_attempts ea
           WHERE ea.student_id = $1
             AND ea.state = 'graded'
             AND ea.max_score > 0
             AND ea.score_total IS NOT NULL)::text AS average_score_percent`,
      [studentUserId],
    );
    const row = rows[0];
    return {
      lessons_purchased: this.toInt(row?.lessons_purchased),
      lessons_completed: this.toInt(row?.lessons_completed),
      courses_purchased: this.toInt(row?.courses_purchased),
      exams_completed: this.toInt(row?.exams_completed),
      average_score_percent: this.toNullableFloat(row?.average_score_percent),
    };
  }

  /**
   * Student-with-access counts for many lessons at once.
   *
   * One grouped query for the whole page rather than a count per row — the list
   * endpoints render up to 100 lessons and an N+1 here would be felt
   * immediately. Lessons with no purchases are simply absent from the map;
   * callers default them to 0.
   */
  public async getLessonStudentCounts(lessonIds: readonly string[]): Promise<Map<string, number>> {
    if (lessonIds.length === 0) return new Map();
    const rows = await this.dataSource.query<LessonStudentCountRow[]>(
      `SELECT lp.lesson_id AS lesson_id, COUNT(DISTINCT lp.student_id)::text AS count
         FROM lesson_purchases lp
        WHERE lp.lesson_id = ANY($1::uuid[]) AND lp.revoked_at IS NULL
        GROUP BY lp.lesson_id`,
      [[...lessonIds]],
    );
    return new Map(rows.map((row) => [row.lesson_id, this.toInt(row.count)]));
  }

  /** Unique students holding non-revoked access to any lesson owned by a teacher. */
  public async getTeacherStudentsWithAccessCount(teacherId: string): Promise<number> {
    const rows = await this.dataSource.query<CountRow[]>(
      `SELECT COUNT(DISTINCT lp.student_id)::text AS count
         FROM lesson_purchases lp
         INNER JOIN lessons l ON l.id = lp.lesson_id
        WHERE l.teacher_id = $1 AND lp.revoked_at IS NULL`,
      [teacherId],
    );
    return this.toInt(rows[0]?.count);
  }

  private toInt(value: string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * `null` is a real answer here — "no graded attempts" — and must survive to
   * the API so the UI can render an empty state instead of a misleading 0%.
   */
  private toNullableFloat(value: string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
