import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { AttendanceRecord } from '../../attendance/entities/attendance-record.entity';
import { LessonSession } from '../../attendance/entities/lesson-session.entity';
import { AttemptState } from '../../exams/entities/attempt-state.enum';
import { ExamAttempt } from '../../exams/entities/exam-attempt.entity';
import { HomeworkSubmission } from '../../lessons/entities/homework-submission.entity';
import { LessonProgress } from '../../lessons/entities/lesson-progress.entity';
import {
  emptyReportPayload,
  PARENT_REPORT_PAYLOAD_VERSION,
  type ParentReportPayload,
} from '../entities/parent-report-payload';
import type { ReportPeriod } from '../logic/report-period';

/**
 * Turns a (student, period) pair into counts.
 *
 * Every number here is *read* from a canonical outcome that some other service
 * already decided — `attendance_records.status`, `exam_attempts.score_total`,
 * `lesson_progress.completed`, `homework_submissions.score`. This service
 * re-implements no grading rule, no pass mark, and no progress formula; it
 * filters those stored verdicts by time and counts them. If a grading rule
 * changes, nothing here needs to change, which is precisely the point.
 *
 * The five queries are aggregate-only (`COUNT`/`SUM`/`AVG` in Postgres, one row
 * back each). No entity hydration, no per-lesson loop: a student with a
 * thousand sessions in a month costs the same five round trips as one with two.
 *
 * All bounds are half-open `[startsAt, endsAt)` — see `report-period.ts`.
 *
 * ## Why the time predicates are spelled out
 *
 * The aggregation sources do not agree on their timestamp types:
 *
 *   `lesson_sessions.entered_at`     timestamp WITHOUT time zone
 *   `attendance_records.marked_at`   timestamp WITHOUT time zone
 *   `exam_attempts.graded_at`        timestamptz
 *   `homework_submissions.*_at`      timestamptz
 *   `lesson_progress.completed_at`   timestamptz
 *
 * Binding a JS `Date` against the naive columns is silently wrong. node-postgres
 * serialises a `Date` using the *Node process's* local offset, and coercing that
 * text to `timestamp` DISCARDS the offset rather than converting it:
 *
 *   '2026-08-03T00:00:00+02:00'::timestamp                    → 2026-08-03 00:00
 *   '2026-08-03T00:00:00+02:00'::timestamptz AT TIME ZONE 'UTC' → 2026-08-02 22:00
 *
 * On a server running anywhere but UTC that shifts every period boundary by the
 * host's offset — moving a Sunday evening's study into the following week, with
 * no error anywhere. So boundaries are bound as explicit UTC ISO strings and
 * each predicate casts for the column it actually compares against.
 *
 * The naive columns hold UTC wall-clock readings (they are written by `now()`
 * under a UTC database session; `SHOW timezone` is UTC on every Learnix
 * deployment), which is what `AT TIME ZONE 'UTC'` converts the boundary into.
 */

/** Half-open bounds as UTC ISO strings — see the note above on why not `Date`. */
interface Bounds {
  start: string;
  end: string;
}

function bounds(period: ReportPeriod): Bounds {
  return { start: period.startsAt.toISOString(), end: period.endsAt.toISOString() };
}

/** Range predicate for a `timestamp WITHOUT time zone` column holding UTC. */
function naiveRange(column: string): string {
  return (
    `${column} >= (CAST(:start AS timestamptz) AT TIME ZONE 'UTC') ` +
    `AND ${column} < (CAST(:end AS timestamptz) AT TIME ZONE 'UTC')`
  );
}

/** Range predicate for a `timestamptz` column. */
function awareRange(column: string): string {
  return `${column} >= CAST(:start AS timestamptz) AND ${column} < CAST(:end AS timestamptz)`;
}
@Injectable()
export class ParentReportAggregatorService {
  private readonly logger = new Logger(ParentReportAggregatorService.name);

  constructor(
    @InjectRepository(LessonSession)
    private readonly sessions: Repository<LessonSession>,
    @InjectRepository(LessonProgress)
    private readonly progress: Repository<LessonProgress>,
    @InjectRepository(AttendanceRecord)
    private readonly attendance: Repository<AttendanceRecord>,
    @InjectRepository(ExamAttempt)
    private readonly attempts: Repository<ExamAttempt>,
    @InjectRepository(HomeworkSubmission)
    private readonly homework: Repository<HomeworkSubmission>,
  ) {}

  public async aggregate(studentId: string, period: ReportPeriod): Promise<ParentReportPayload> {
    const [study, completed, attendance, exams, homework] = await Promise.all([
      this.studyStats(studentId, period),
      this.completedLessons(studentId, period),
      this.attendanceStats(studentId, period),
      this.examStats(studentId, period),
      this.homeworkStats(studentId, period),
    ]);

    const payload: ParentReportPayload = {
      version: PARENT_REPORT_PAYLOAD_VERSION,
      study: { ...study, completed },
      attendance,
      exams,
      homework,
      hasActivity:
        study.sessions > 0 ||
        completed > 0 ||
        attendance.total > 0 ||
        exams.graded > 0 ||
        homework.submitted > 0,
    };

    this.logger.debug(
      `Aggregated ${period.type} report for student ${studentId} (${period.key}): ` +
        `${String(payload.study.sessions)} sessions, ${String(payload.attendance.total)} attendance, ` +
        `${String(payload.exams.graded)} graded exams`,
    );

    return payload;
  }

  /**
   * Study effort, from `lesson_sessions` rather than `lesson_progress`.
   *
   * `lesson_progress.watched_duration` is a *cumulative* total for the lesson,
   * so summing it over rows touched in the period would report a student's
   * entire history as this week's effort. Sessions carry a per-visit
   * `duration_seconds`, which is the only per-period figure available.
   */
  private async studyStats(
    studentId: string,
    period: ReportPeriod,
  ): Promise<{ sessions: number; lessons: number; minutes: number }> {
    const row = await this.sessions
      .createQueryBuilder('s')
      .select('COUNT(*)', 'sessions')
      .addSelect('COUNT(DISTINCT s.lesson_id)', 'lessons')
      .addSelect('COALESCE(SUM(s.duration_seconds), 0)', 'seconds')
      .where('s.student_id = :studentId', { studentId })
      .andWhere(naiveRange('s.entered_at'))
      .setParameters(bounds(period))
      .getRawOne<{ sessions: string; lessons: string; seconds: string }>();

    return {
      sessions: toInt(row?.sessions),
      lessons: toInt(row?.lessons),
      minutes: Math.round(toInt(row?.seconds) / 60),
    };
  }

  /**
   * Lessons finished *in* the period.
   *
   * Keyed on `completed_at`, which is stamped once at the transition. Rows
   * completed before that column existed are null and are correctly excluded —
   * they were not completed in this period either.
   */
  private async completedLessons(studentId: string, period: ReportPeriod): Promise<number> {
    return await this.progress
      .createQueryBuilder('p')
      .where('p.student_id = :studentId', { studentId })
      .andWhere('p.completed = true')
      .andWhere(awareRange('p.completed_at'))
      .setParameters(bounds(period))
      .getCount();
  }

  private async attendanceStats(
    studentId: string,
    period: ReportPeriod,
  ): Promise<ParentReportPayload['attendance']> {
    const rows = await this.attendance
      .createQueryBuilder('a')
      .select('a.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('a.student_id = :studentId', { studentId })
      .andWhere(naiveRange('a.marked_at'))
      .setParameters(bounds(period))
      .groupBy('a.status')
      .getRawMany<{ status: string; count: string }>();

    const counts = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    for (const row of rows) {
      const count = toInt(row.count);
      counts.total += count;
      if (row.status === 'present') counts.present = count;
      else if (row.status === 'absent') counts.absent = count;
      else if (row.status === 'late') counts.late = count;
      else if (row.status === 'excused') counts.excused = count;
    }
    return counts;
  }

  /**
   * Exam outcomes, keyed on `graded_at`.
   *
   * Graded — not submitted — because that is when a result exists to tell a
   * parent about, and because an attempt sitting in manual-grading limbo would
   * otherwise be reported as a missing score. `passed` is the stored verdict;
   * this never re-applies a pass mark of its own.
   *
   * `max_score = 0` attempts are excluded from the average rather than divided
   * by zero (Postgres would raise, aborting the whole report).
   */
  private async examStats(
    studentId: string,
    period: ReportPeriod,
  ): Promise<ParentReportPayload['exams']> {
    const row = await this.attempts
      .createQueryBuilder('a')
      .select('COUNT(*)', 'graded')
      .addSelect('COUNT(*) FILTER (WHERE a.passed IS TRUE)', 'passed')
      .addSelect('COUNT(*) FILTER (WHERE a.passed IS FALSE)', 'failed')
      .addSelect(
        'AVG(a.score_total / NULLIF(a.max_score, 0) * 100) FILTER (WHERE a.score_total IS NOT NULL)',
        'avgPercent',
      )
      .where('a.student_id = :studentId', { studentId })
      .andWhere('a.state = :state', { state: AttemptState.GRADED })
      .andWhere(awareRange('a.graded_at'))
      .setParameters(bounds(period))
      .getRawOne<{ graded: string; passed: string; failed: string; avgPercent: string | null }>();

    return {
      graded: toInt(row?.graded),
      passed: toInt(row?.passed),
      failed: toInt(row?.failed),
      averagePercent: toPercent(row?.avgPercent),
    };
  }

  /**
   * Homework activity.
   *
   * Two different clocks on purpose: a submission counts as *submitted* in the
   * period it was handed in, and as *graded* in the period the teacher marked
   * it — which is often the following one. Counting both against `submitted_at`
   * would make a teacher's late marking silently vanish from every report.
   */
  private async homeworkStats(
    studentId: string,
    period: ReportPeriod,
  ): Promise<ParentReportPayload['homework']> {
    const inSubmitWindow = awareRange('h.submitted_at');
    const inGradeWindow = awareRange('h.graded_at');

    const row = await this.homework
      .createQueryBuilder('h')
      .leftJoin('h.homework', 'a')
      .select(`COUNT(*) FILTER (WHERE ${inSubmitWindow})`, 'submitted')
      .addSelect(`COUNT(*) FILTER (WHERE h.is_late IS TRUE AND ${inSubmitWindow})`, 'late')
      .addSelect(`COUNT(*) FILTER (WHERE ${inGradeWindow})`, 'graded')
      .addSelect(
        'AVG(h.score / NULLIF(a.max_score, 0) * 100) FILTER ' +
          `(WHERE h.score IS NOT NULL AND ${inGradeWindow})`,
        'avgPercent',
      )
      .where('h.student_id = :studentId', { studentId })
      .andWhere(`((${inSubmitWindow}) OR (${inGradeWindow}))`)
      .setParameters(bounds(period))
      .getRawOne<{ submitted: string; late: string; graded: string; avgPercent: string | null }>();

    return {
      submitted: toInt(row?.submitted),
      graded: toInt(row?.graded),
      late: toInt(row?.late),
      averagePercent: toPercent(row?.avgPercent),
    };
  }
}

/** Postgres returns COUNT/SUM as strings; missing rows as undefined. */
function toInt(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** AVG comes back as a numeric string, or null when nothing matched. */
function toPercent(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function isEmptyPayload(payload: ParentReportPayload): boolean {
  return !payload.hasActivity;
}

export { emptyReportPayload };
