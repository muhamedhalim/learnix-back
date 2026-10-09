import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository, SelectQueryBuilder } from 'typeorm';

import { ParentEventType } from '../common/events/parent-event-type.enum';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { HomeworkSubmission } from '../lessons/entities/homework-submission.entity';
import { LessonHomework } from '../lessons/entities/lesson-homework.entity';
import { AttemptState } from '../exams/entities/attempt-state.enum';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { GuardianVerificationStatus, StudentGuardian } from '../guardians/entities';
import { NotificationOrigin, ParentMessage } from '../notifications/entities';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
import {
  ParentMessageAdminService,
  type StudentScope,
} from '../notifications/services/parent-message-admin.service';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { biBody } from '../i18n/error-translator.util';
import { User } from '../users/entities/user.entity';
import { homeworkStatsAudienceSql } from '../payments/lesson-audience';
import { UserRole } from '../users/entities/user-role.enum';
import type {
  AttendanceSummary,
  HomeworkSummary,
  LatestExamSummary,
  RiskAssessment,
  RiskLevel,
  StudentGuardianSummary,
  TeacherStudentSummary,
} from './teacher-follow-up.types';

const INACTIVITY_DAYS = 14;
const LOW_SCORE_THRESHOLD = 60;
const LOW_ATTENDANCE_THRESHOLD = 70;
/** Guardian must have had at least this many delivered messages before "never reads" is meaningful. */
const UNREAD_SAMPLE_SIZE = 3;

/** The owned-students subquery and its named binds (see `ownedStudentIdsSubQuery`). */
export type OwnedStudentsScope = Extract<StudentScope, { sql: string }>;

/** One row per owned student from `countRiskStudents`; bigint counts arrive as strings, absent CTE rows as null. */
interface RiskAggregateRow {
  student_id: string;
  n: string | null;
  pct_sum: number | null;
  total: string | null;
  present_like: string | null;
  last_active: Date | string | null;
  guardian_id: string | null;
  full_name: string | null;
  phone_e164: string | null;
  verification_status: string | null;
  whatsapp_capable: boolean | null;
  opted_out_at: Date | string | null;
  is_primary: boolean | null;
  delivered_count: string | null;
  read_count: string | null;
  assigned: string | null;
  submitted: string | null;
  late: string | null;
}

export interface AttemptRow {
  id: string;
  student_id: string;
  state: AttemptState;
  score_total: string | null;
  max_score: string;
  passed: boolean | null;
  graded_at: Date | null;
  started_at: Date;
  submitted_at: Date | null;
  exam_name: string;
}

export interface AttendanceRow {
  id: string;
  student_id: string;
  status: string;
  marked_at: Date;
  lesson_name: string;
}

export interface HomeworkRow {
  id: string;
  student_id: string;
  status: string;
  score: string | null;
  max_score: string;
  submitted_at: Date;
  graded_at: Date | null;
  is_late: boolean;
  homework_title: string;
}

/**
 * Everything needed to render the teacher's "Parents & Follow-up" surface.
 *
 * There is no direct teacher↔student table anywhere in this schema — ownership
 * is always transitive through a purchased lesson or package, exactly the join
 * `ReportsService` already uses for teacher revenue/stats. This service reuses
 * that same shape so a teacher can never see a student who never bought
 * anything from them.
 */
@Injectable()
export class TeacherFollowUpService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(LessonPurchase) private readonly lessonPurchases: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchases: Repository<PackagePurchase>,
    @InjectRepository(ExamAttempt) private readonly examAttempts: Repository<ExamAttempt>,
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRecords: Repository<AttendanceRecord>,
    @InjectRepository(LessonSession) private readonly lessonSessions: Repository<LessonSession>,
    @InjectRepository(ParentMessage) private readonly parentMessages: Repository<ParentMessage>,
    @InjectRepository(LessonHomework)
    private readonly homework: Repository<LessonHomework>,
    @InjectRepository(HomeworkSubmission)
    private readonly homeworkSubmissions: Repository<HomeworkSubmission>,
    @InjectRepository(StudentGuardian)
    private readonly studentGuardians: Repository<StudentGuardian>,
    private readonly parentMessageAdmin: ParentMessageAdminService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Purchases of a lesson this teacher owns (soft-deleted lessons excluded by the relation join). */
  private ownedViaLessonsQuery(): SelectQueryBuilder<LessonPurchase> {
    return this.lessonPurchases
      .createQueryBuilder('lp')
      .innerJoin('lp.lesson', 'lesson')
      .where('lesson.teacher_id = :ownerTeacherId')
      .select('lp.student_id', 'student_id');
  }

  /** Purchases of a package that contains one of this teacher's lessons (same soft-delete semantics). */
  private ownedViaPackagesQuery(): SelectQueryBuilder<PackagePurchase> {
    return this.packagePurchases
      .createQueryBuilder('pp')
      .innerJoin('pp.package', 'package')
      .innerJoin('package.items', 'items')
      .innerJoin('items.lesson', 'lesson')
      .where('lesson.teacher_id = :ownerTeacherId')
      .select('pp.student_id', 'student_id');
  }

  /**
   * "Students who have ever purchased one of this teacher's lessons or packages"
   * as a SQL subquery (T066), generated from the very query builders the id-array
   * form used, so the soft-delete join conditions are identical. Revoked and
   * expired purchases still count. The only bind is `:ownerTeacherId`, a name no
   * caller filter uses; callers embed `sql` in `... IN (${sql})` and pass
   * `params`. Never expose an id-taking variant: ownership is derived from the
   * authenticated teacher only.
   */
  public ownedStudentIdsSubQuery(teacherId: string): OwnedStudentsScope {
    return {
      sql: `${this.ownedViaLessonsQuery().getQuery()} UNION ${this.ownedViaPackagesQuery().getQuery()}`,
      params: { ownerTeacherId: teacherId },
    };
  }

  /** Throws 403 unless `studentId` has ever purchased something from `teacherId`. */
  public async assertOwnsStudent(teacherId: string, studentId: string): Promise<void> {
    const viaLessons = this.ownedViaLessonsQuery().andWhere('lp.student_id = :studentId').getQuery();
    const viaPackages = this.ownedViaPackagesQuery().andWhere('pp.student_id = :studentId').getQuery();
    const [sql, values] = this.users.manager.connection.driver.escapeQueryWithParameters(
      `SELECT (EXISTS(${viaLessons}) OR EXISTS(${viaPackages})) AS owned`,
      { ownerTeacherId: teacherId, studentId },
      {},
    );
    const rows: { owned: boolean }[] = await this.users.manager.query(sql, values);

    if (rows[0]?.owned !== true) {
      throw new ForbiddenException(
        biBody('You can only access your own students', 'يمكنك الوصول إلى طلابك الخاصين فقط'),
      );
    }
  }

  public async sendStudentMessage(
    teacherId: string,
    studentId: string,
    message: string,
    title?: string,
  ) {
    await this.assertOwnsStudent(teacherId, studentId);
    const teacher = await this.users.findOneOrFail({ where: { id: teacherId } });
    return this.notifications.create(
      {
        user_id: studentId,
        type: NotificationType.CUSTOM,
        title: title?.trim() || `Message from ${teacher.name}`,
        message: message.trim(),
        data: { teacher_id: teacherId, href: '/student/notifications' },
        send_sms: false,
      },
      false,
      {
        origin: NotificationOrigin.TEACHER_MANUAL,
        sourceEvent: 'teacher_student_message',
        createdByUserId: teacherId,
      },
    );
  }

  /**
   * Paginated roster with guardian/notification/attendance/exam/risk data.
   *
   * Every aggregate below is a single grouped query across the whole page of
   * student ids, not one query per student — the page can safely grow to
   * hundreds of rows without turning into an N+1.
   */
  public async getRoster(
    teacherId: string,
    options: { search?: string; page?: number; limit?: number },
  ): Promise<{ data: TeacherStudentSummary[]; total: number; page: number; limit: number }> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;

    const owned = this.ownedStudentIdsSubQuery(teacherId);
    const qb = this.users
      .createQueryBuilder('u')
      .where(`u.id IN (${owned.sql})`, owned.params)
      .andWhere('u.role = :role', { role: UserRole.STUDENT });

    if (options.search !== undefined && options.search !== '') {
      qb.andWhere('(u.name ILIKE :q OR u.email ILIKE :q OR u.phone ILIKE :q)', {
        q: `%${options.search}%`,
      });
    }

    qb.orderBy('u.name', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [students, total] = await qb.getManyAndCount();
    const summaries = await this.buildSummaries(teacherId, students);

    return {
      data: students.map((s) => summaries.get(s.id) ?? this.emptySummary(s)),
      total,
      page,
      limit,
    };
  }

  public async getStudentSummary(
    teacherId: string,
    studentId: string,
  ): Promise<TeacherStudentSummary> {
    await this.assertOwnsStudent(teacherId, studentId);
    const student = await this.users.findOneOrFail({ where: { id: studentId } });
    const summaries = await this.buildSummaries(teacherId, [student]);
    return summaries.get(studentId) ?? this.emptySummary(student);
  }

  /**
   * Guardian/notification/risk figures for the teacher analytics extension.
   * Reuses `ParentMessageAdminService.stats` (the same delivery/read-rate
   * math the admin dashboard uses). The risk count comes from one per-student
   * aggregate statement (`countRiskStudents`) that feeds the same `assessRisk`
   * the roster uses; rules and equality checklist: gates/W4-C2-risk-sql.md.
   */
  public async getAnalyticsSummary(teacherId: string): Promise<{
    guardians: { total: number; verified: number; pending: number };
    notifications: { today: number; deliveryRate: number; readRate: number };
    riskStudentCount: number;
  }> {
    const owned = this.ownedStudentIdsSubQuery(teacherId);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [guardianRows, todayCount, messageStats, riskStudentCount] = await Promise.all([
      this.studentGuardians
        .createQueryBuilder('sg')
        .innerJoin('sg.guardian', 'g')
        .where(`sg.student_id IN (${owned.sql})`, owned.params)
        .andWhere('g.deleted_at IS NULL')
        .distinct(true)
        .select('g.id', 'id')
        .addSelect('g.verification_status', 'status')
        .getRawMany<{ id: string; status: GuardianVerificationStatus }>(),
      this.parentMessages
        .createQueryBuilder('m')
        .where(`m.student_id IN (${owned.sql})`, owned.params)
        .andWhere('m.created_at >= :startOfToday', { startOfToday })
        .getCount(),
      this.parentMessageAdmin.stats(owned),
      this.countRiskStudents(teacherId, owned),
    ]);

    const verified = guardianRows.filter(
      (r) => r.status === GuardianVerificationStatus.VERIFIED,
    ).length;
    return {
      guardians: { total: guardianRows.length, verified, pending: guardianRows.length - verified },
      notifications: {
        today: todayCount,
        deliveryRate: messageStats.delivery_rate,
        readRate: messageStats.read_rate,
      },
      riskStudentCount,
    };
  }

  /**
   * How many owned students have at least one risk factor, from ONE statement of per-student
   * aggregates (rows transferred are O(students), not O(students x history)). It returns raw
   * figures only; every threshold, rounding step and factor rule is the unchanged JS
   * (`roundAverage`, `assessRisk`), so the rules have one source of truth. Each CTE carries
   * the hidden predicates of the TypeORM reads it replaces (soft-deleted exams/lessons/guardians/
   * users); the item-by-item equality checklist is gates/W4-C2-risk-sql.md (E1-E20).
   */
  private async countRiskStudents(teacherId: string, owned: OwnedStudentsScope): Promise<number> {
    const [sql, values] = this.users.manager.connection.driver.escapeQueryWithParameters(
      `
        WITH live AS (
          SELECT u.id FROM users u
          WHERE u.deleted_at IS NULL AND u.id IN (${owned.sql})
        ),
        att AS (
          SELECT a.student_id,
                 COUNT(*) AS n,
                 SUM(CASE WHEN a.max_score::float8 > 0
                       THEN (COALESCE(a.score_total, 0)::float8 / a.max_score::float8) * 100
                       ELSE 0::float8 END) AS pct_sum
          FROM exam_attempts a
          INNER JOIN exams e ON e.id = a.exam_id AND e.deleted_at IS NULL
          WHERE e.teacher_id = :ownerTeacherId
            AND a.student_id IN (SELECT id FROM live)
            AND a.state = 'graded' AND a.graded_at IS NOT NULL
          GROUP BY a.student_id
        ),
        rec AS (
          SELECT r.student_id,
                 COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE r.status IN ('present', 'late')) AS present_like
          FROM attendance_records r
          INNER JOIN lessons l ON l.id = r.lesson_id AND l.deleted_at IS NULL
          WHERE l.teacher_id = :ownerTeacherId AND r.student_id IN (SELECT id FROM live)
          GROUP BY r.student_id
        ),
        act AS (
          SELECT s.student_id, MAX(s.entered_at) AS last_active
          FROM lesson_sessions s
          INNER JOIN lessons l ON l.id = s.lesson_id AND l.deleted_at IS NULL
          WHERE l.teacher_id = :ownerTeacherId AND s.student_id IN (SELECT id FROM live)
          GROUP BY s.student_id
        ),
        grd AS (
          SELECT DISTINCT ON (sg.student_id)
                 sg.student_id, g.id AS guardian_id, g.full_name, g.phone_e164,
                 g.verification_status, g.whatsapp_capable, g.opted_out_at, sg.is_primary
          FROM student_guardians sg
          INNER JOIN guardians g ON g.id = sg.guardian_id AND g.deleted_at IS NULL
          WHERE sg.student_id IN (SELECT id FROM live)
          ORDER BY sg.student_id, sg.is_primary DESC, sg.created_at ASC, sg.id ASC
        ),
        subj AS (
          SELECT a.id::text AS subject_id
          FROM exam_attempts a
          INNER JOIN exams e ON e.id = a.exam_id AND e.deleted_at IS NULL
          WHERE e.teacher_id = :ownerTeacherId AND a.student_id IN (SELECT id FROM live)
          UNION ALL
          SELECT r.id::text
          FROM attendance_records r
          INNER JOIN lessons l ON l.id = r.lesson_id AND l.deleted_at IS NULL
          WHERE l.teacher_id = :ownerTeacherId AND r.student_id IN (SELECT id FROM live)
        ),
        msg AS (
          SELECT m.student_id,
                 COUNT(*) FILTER (WHERE m.status IN ('delivered', 'read')) AS delivered_count,
                 COUNT(*) FILTER (WHERE m.status = 'read') AS read_count
          FROM parent_messages m
          WHERE m.student_id IN (SELECT id FROM live)
            AND m.event_type IN ('exam_graded', 'attendance_marked')
            AND split_part(m.idempotency_key, ':', 2) IN (SELECT subject_id FROM subj)
          GROUP BY m.student_id
        ),
        hw AS (
          ${homeworkStatsSql(':ownerTeacherId', 'student.id IN (SELECT id FROM live)')}
        )
        SELECT live.id AS student_id,
               att.n, att.pct_sum, rec.total, rec.present_like, act.last_active,
               grd.guardian_id, grd.full_name, grd.phone_e164, grd.verification_status,
               grd.whatsapp_capable, grd.opted_out_at, grd.is_primary,
               msg.delivered_count, msg.read_count,
               hw.assigned, hw.submitted, hw.late
        FROM live
        LEFT JOIN att ON att.student_id = live.id
        LEFT JOIN rec ON rec.student_id = live.id
        LEFT JOIN act ON act.student_id = live.id
        LEFT JOIN grd ON grd.student_id = live.id
        LEFT JOIN msg ON msg.student_id = live.id
        LEFT JOIN hw ON hw.student_id = live.id
      `,
      { ownerTeacherId: teacherId },
      {},
    );
    const rows: RiskAggregateRow[] = await this.users.manager.query(sql, values);

    let count = 0;
    for (const row of rows) {
      const attempts = Number(row.n ?? 0);
      const attendanceTotal = Number(row.total ?? 0);
      const assigned = Number(row.assigned ?? 0);
      const submitted = Number(row.submitted ?? 0);
      const guardian: StudentGuardianSummary | null =
        row.guardian_id === null
          ? null
          : {
              guardianId: row.guardian_id,
              fullName: row.full_name,
              phoneE164: row.phone_e164 ?? '',
              verificationStatus: row.verification_status as GuardianVerificationStatus,
              whatsappCapable: row.whatsapp_capable ?? false,
              optedOut: row.opted_out_at !== null,
              isPrimary: row.is_primary ?? false,
            };
      const risk = assessRisk({
        averageExamScore: attempts > 0 ? roundAverage(Number(row.pct_sum), attempts) : null,
        attendanceRate:
          attendanceTotal > 0
            ? Math.round((Number(row.present_like) / attendanceTotal) * 100)
            : null,
        homeworkCompletionRate: assigned > 0 ? Math.round((submitted / assigned) * 100) : null,
        lateHomeworkCount: Number(row.late ?? 0),
        lastActive: row.last_active === null ? null : new Date(row.last_active),
        guardian,
        deliveredCount: Number(row.delivered_count ?? 0),
        readCount: Number(row.read_count ?? 0),
      });
      if (risk.level !== 'low') count += 1;
    }
    return count;
  }

  private emptySummary(student: User): TeacherStudentSummary {
    return {
      id: student.id,
      name: student.name,
      email: student.email,
      phone: student.phone,
      guardian: null,
      lastNotification: null,
      lastReadAt: null,
      attendance: { total: 0, rate: null, lastStatus: null, lastMarkedAt: null },
      latestExam: null,
      averageExamScore: null,
      homework: this.emptyHomeworkSummary(),
      risk: { level: 'low', factors: [] },
    };
  }

  /** Shared aggregation used by both the roster page and the single-student detail view. */
  private async buildSummaries(
    teacherId: string,
    students: User[],
  ): Promise<Map<string, TeacherStudentSummary>> {
    const studentIds = students.map((student) => student.id);

    const [attemptRows, attendanceRows, homeworkSummaries, lastActiveRows, guardianRows] =
      await Promise.all([
        this.fetchAttemptRows(teacherId, studentIds),
        this.fetchAttendanceRows(teacherId, studentIds),
        this.fetchHomeworkSummaries(teacherId, studentIds),
        this.fetchLastActiveRows(teacherId, studentIds),
        this.fetchGuardianRows(studentIds),
      ]);

    const attemptsByStudent = groupBy(attemptRows, (r) => r.student_id);
    const attendanceByStudent = groupBy(attendanceRows, (r) => r.student_id);
    const lastActiveByStudent = new Map(lastActiveRows.map((r) => [r.student_id, r.last_active]));
    const guardianByStudent = pickPrimaryGuardian(guardianRows);

    // Scope parent_messages to *this teacher's* attempts/attendance only — a
    // message about another teacher's exam for a shared student must never
    // surface here (see the "own notifications" security requirement).
    const subjectIds = [...attemptRows.map((r) => r.id), ...attendanceRows.map((r) => r.id)];
    const messagesByStudent = await this.fetchScopedMessages(studentIds, subjectIds);

    const result = new Map<string, TeacherStudentSummary>();
    for (const student of students) {
      const attempts = attemptsByStudent.get(student.id) ?? [];
      const attendance = attendanceByStudent.get(student.id) ?? [];
      const lastActive = lastActiveByStudent.get(student.id) ?? null;
      const guardian = guardianByStudent.get(student.id) ?? null;
      const messages = messagesByStudent.get(student.id) ?? [];

      const attendanceSummary = summarizeAttendance(attendance);
      const { latestExam, averageExamScore } = summarizeExams(attempts);
      const homework = homeworkSummaries.get(student.id) ?? this.emptyHomeworkSummary();
      const lastMessage = messages[0] ?? null;
      const lastReadAt = messages.find((m) => m.read_at !== null)?.read_at ?? null;
      const deliveredCount = messages.filter(
        (m) => m.status === 'delivered' || m.status === 'read',
      ).length;
      const readCount = messages.filter((m) => m.status === 'read').length;

      const risk = assessRisk({
        averageExamScore,
        attendanceRate: attendanceSummary.rate,
        homeworkCompletionRate: homework.completionRate,
        lateHomeworkCount: homework.late,
        lastActive,
        guardian,
        deliveredCount,
        readCount,
      });

      result.set(student.id, {
        id: student.id,
        name: student.name,
        email: student.email,
        phone: student.phone,
        guardian,
        lastNotification: lastMessage
          ? {
              eventType: lastMessage.event_type,
              channel: lastMessage.channel,
              status: lastMessage.status,
              createdAt: lastMessage.created_at.toISOString(),
            }
          : null,
        lastReadAt: lastReadAt?.toISOString() ?? null,
        attendance: attendanceSummary,
        latestExam,
        averageExamScore,
        homework,
        risk,
      });
    }

    return result;
  }

  private async fetchAttemptRows(teacherId: string, studentIds: string[]): Promise<AttemptRow[]> {
    if (studentIds.length === 0) return [];
    return this.examAttempts
      .createQueryBuilder('a')
      .innerJoin('a.exam', 'exam')
      .where('exam.teacher_id = :teacherId', { teacherId })
      .andWhere('a.student_id = ANY(:studentIds)', { studentIds })
      .select([
        'a.id AS id',
        'a.student_id AS student_id',
        'a.state AS state',
        'a.score_total AS score_total',
        'a.max_score AS max_score',
        'a.passed AS passed',
        'a.graded_at AS graded_at',
        'a.started_at AS started_at',
        'a.submitted_at AS submitted_at',
        'exam.title AS exam_name',
      ])
      .getRawMany<AttemptRow>();
  }

  private async fetchAttendanceRows(
    teacherId: string,
    studentIds: string[],
  ): Promise<AttendanceRow[]> {
    if (studentIds.length === 0) return [];
    return this.attendanceRecords
      .createQueryBuilder('rec')
      .innerJoin('rec.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('rec.student_id = ANY(:studentIds)', { studentIds })
      .select([
        'rec.id AS id',
        'rec.student_id AS student_id',
        'rec.status AS status',
        'rec.marked_at AS marked_at',
        'lesson.title AS lesson_name',
      ])
      .getRawMany<AttendanceRow>();
  }

  private async fetchHomeworkRows(teacherId: string, studentIds: string[]): Promise<HomeworkRow[]> {
    if (studentIds.length === 0) return [];
    return this.homeworkSubmissions
      .createQueryBuilder('submission')
      .innerJoin('submission.homework', 'homework')
      .innerJoin('homework.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('submission.student_id = ANY(:studentIds)', { studentIds })
      .select([
        'submission.id AS id',
        'submission.student_id AS student_id',
        'submission.status AS status',
        'submission.score AS score',
        'homework.max_score AS max_score',
        'submission.submitted_at AS submitted_at',
        'submission.graded_at AS graded_at',
        'submission.is_late AS is_late',
        'homework.title AS homework_title',
      ])
      .getRawMany<HomeworkRow>();
  }

  private async fetchHomeworkSummaries(
    teacherId: string,
    studentIds: string[],
  ): Promise<Map<string, HomeworkSummary>> {
    if (studentIds.length === 0) return new Map();
    const rows = await this.homework.query<
      Array<{
        student_id: string;
        assigned: string;
        submitted: string;
        graded: string;
        late: string;
        average_score: string | null;
        last_submitted_at: Date | string | null;
      }>
    >(
      homeworkStatsSql('$1', 'student.id = ANY($2::uuid[])'),
      [teacherId, studentIds],
    );

    return new Map(
      rows.map((row) => {
        const assigned = Number.parseInt(row.assigned, 10);
        const submitted = Number.parseInt(row.submitted, 10);
        return [
          row.student_id,
          {
            assigned,
            submitted,
            graded: Number.parseInt(row.graded, 10),
            late: Number.parseInt(row.late, 10),
            completionRate: assigned > 0 ? Math.round((submitted / assigned) * 100) : null,
            averageScore: row.average_score === null ? null : Number(row.average_score),
            lastSubmittedAt:
              row.last_submitted_at === null ? null : new Date(row.last_submitted_at).toISOString(),
          },
        ];
      }),
    );
  }

  private async fetchLastActiveRows(
    teacherId: string,
    studentIds: string[],
  ): Promise<{ student_id: string; last_active: Date | null }[]> {
    if (studentIds.length === 0) return [];
    return this.lessonSessions
      .createQueryBuilder('s')
      .innerJoin('s.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('s.student_id = ANY(:studentIds)', { studentIds })
      .select('s.student_id', 'student_id')
      .addSelect('MAX(s.entered_at)', 'last_active')
      .groupBy('s.student_id')
      .getRawMany();
  }

  private async fetchGuardianRows(
    studentIds: string[],
  ): Promise<(StudentGuardianSummary & { student_id: string })[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.studentGuardians
      .createQueryBuilder('sg')
      .innerJoin('sg.guardian', 'g')
      .where('sg.student_id = ANY(:studentIds)', { studentIds })
      .andWhere('g.deleted_at IS NULL')
      .select([
        'sg.student_id AS student_id',
        'sg.is_primary AS "isPrimary"',
        'g.id AS "guardianId"',
        'g.full_name AS "fullName"',
        'g.phone_e164 AS "phoneE164"',
        'g.verification_status AS "verificationStatus"',
        'g.whatsapp_capable AS "whatsappCapable"',
        'g.opted_out_at AS "optedOutAt"',
      ])
      .orderBy('sg.is_primary', 'DESC')
      .addOrderBy('sg.created_at', 'ASC')
      .getRawMany<{
        student_id: string;
        isPrimary: boolean;
        guardianId: string;
        fullName: string | null;
        phoneE164: string;
        verificationStatus: GuardianVerificationStatus;
        whatsappCapable: boolean;
        optedOutAt: Date | null;
      }>();

    return rows.map((r) => ({
      student_id: r.student_id,
      guardianId: r.guardianId,
      fullName: r.fullName,
      phoneE164: r.phoneE164,
      verificationStatus: r.verificationStatus,
      whatsappCapable: r.whatsappCapable,
      optedOut: r.optedOutAt !== null,
      isPrimary: r.isPrimary,
    }));
  }

  /** Full message rows for the given students, restricted to `subjectIds` this teacher actually owns. */
  private async fetchScopedMessages(
    studentIds: string[],
    subjectIds: string[],
  ): Promise<Map<string, ParentMessage[]>> {
    if (studentIds.length === 0 || subjectIds.length === 0) return new Map();

    const rows = await this.parentMessages
      .createQueryBuilder('m')
      .where('m.student_id = ANY(:studentIds)', { studentIds })
      .andWhere('m.event_type IN (:...eventTypes)', {
        eventTypes: [ParentEventType.EXAM_GRADED, ParentEventType.ATTENDANCE_MARKED],
      })
      // idempotency_key is `<event_type>:<subjectId>:<guardianId>` — extracting
      // the subject id is how we prove this message is about *this teacher's*
      // exam/attendance record, not another teacher's, for a shared student.
      .andWhere("split_part(m.idempotency_key, ':', 2) = ANY(:subjectIds)", { subjectIds })
      .orderBy('m.created_at', 'DESC')
      .getMany();

    return groupBy(rows, (r) => r.student_id);
  }

  /** Exposed for the timeline and broadcast services, which need the same raw rows. */
  public async fetchAttemptRowsFor(teacherId: string, studentId: string): Promise<AttemptRow[]> {
    return this.fetchAttemptRows(teacherId, [studentId]);
  }

  public async fetchAttendanceRowsFor(
    teacherId: string,
    studentId: string,
  ): Promise<AttendanceRow[]> {
    return this.fetchAttendanceRows(teacherId, [studentId]);
  }

  public async fetchHomeworkRowsFor(teacherId: string, studentId: string): Promise<HomeworkRow[]> {
    return this.fetchHomeworkRows(teacherId, [studentId]);
  }

  public async fetchScopedMessagesFor(
    teacherId: string,
    studentId: string,
  ): Promise<ParentMessage[]> {
    const { messages } = await this.fetchTimelineSourcesFor(teacherId, studentId);
    return messages;
  }

  /**
   * Attempts, attendance and the parent messages about exactly those records, with
   * each of the first two fetched once (the timeline used to fetch them again
   * inside `fetchScopedMessagesFor`). Inputs are only `(teacherId, studentId)`: the
   * record ids that scope the messages are derived here and never accepted from a
   * caller, so another teacher's attempt ids cannot be supplied.
   */
  public async fetchTimelineSourcesFor(
    teacherId: string,
    studentId: string,
  ): Promise<{ attempts: AttemptRow[]; attendance: AttendanceRow[]; messages: ParentMessage[] }> {
    const [attempts, attendance] = await Promise.all([
      this.fetchAttemptRows(teacherId, [studentId]),
      this.fetchAttendanceRows(teacherId, [studentId]),
    ]);
    const subjectIds = [...attempts.map((r) => r.id), ...attendance.map((r) => r.id)];
    const byStudent = await this.fetchScopedMessages([studentId], subjectIds);
    return { attempts, attendance, messages: byStudent.get(studentId) ?? [] };
  }

  private emptyHomeworkSummary(): HomeworkSummary {
    return {
      assigned: 0,
      submitted: 0,
      graded: 0,
      late: 0,
      completionRate: null,
      averageScore: null,
      lastSubmittedAt: null,
    };
  }
}

/**
 * The homework statistics statement body (one row per student with at least one assigned homework in their
 * audience), parameterised only by how the teacher id and the student set are referenced so the roster fetch
 * ($1/$2 binds) and the risk statement (named bind + CTE) run the very same SQL.
 */
function homeworkStatsSql(teacherRef: string, studentsPredicate: string): string {
  return `
        SELECT
          student.id AS student_id,
          COUNT(DISTINCT homework.id) AS assigned,
          COUNT(DISTINCT submission.id) AS submitted,
          COUNT(DISTINCT submission.id) FILTER (WHERE submission.status = 'graded') AS graded,
          COUNT(DISTINCT submission.id) FILTER (WHERE submission.is_late = true) AS late,
          ROUND(AVG(
            CASE WHEN submission.status = 'graded' AND homework.max_score > 0
              THEN submission.score / homework.max_score * 100 ELSE NULL END
          ), 2) AS average_score,
          MAX(submission.submitted_at) AS last_submitted_at
        FROM users student
        INNER JOIN lesson_homework homework
          ON homework.published_at IS NOT NULL AND homework.deleted_at IS NULL
        INNER JOIN lessons lesson
          ON lesson.id = homework.lesson_id AND lesson.teacher_id = ${teacherRef} AND lesson.deleted_at IS NULL
        LEFT JOIN homework_submissions submission
          ON submission.homework_id = homework.id AND submission.student_id = student.id
        WHERE ${studentsPredicate}
          AND (${homeworkStatsAudienceSql('student', 'homework')}
          )
        GROUP BY student.id
      `;
}

/** The exam-average rounding used by both the roster and the risk count: two decimals, half-up on the double. */
function roundAverage(sum: number, count: number): number {
  return Math.round((sum / count) * 100) / 100;
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function pickPrimaryGuardian(
  rows: (StudentGuardianSummary & { student_id: string })[],
): Map<string, StudentGuardianSummary> {
  const map = new Map<string, StudentGuardianSummary>();
  for (const row of rows) {
    if (!map.has(row.student_id)) {
      const { student_id: _student_id, ...guardian } = row;
      map.set(row.student_id, guardian);
    }
  }
  return map;
}

function summarizeAttendance(rows: AttendanceRow[]): AttendanceSummary {
  if (rows.length === 0) return { total: 0, rate: null, lastStatus: null, lastMarkedAt: null };

  const presentLike = rows.filter((r) => r.status === 'present' || r.status === 'late').length;
  const latest = rows.reduce((a, b) => (b.marked_at > a.marked_at ? b : a));

  return {
    total: rows.length,
    rate: Math.round((presentLike / rows.length) * 100),
    lastStatus: latest.status,
    lastMarkedAt: latest.marked_at.toISOString(),
  };
}

function summarizeExams(rows: AttemptRow[]): {
  latestExam: LatestExamSummary | null;
  averageExamScore: number | null;
} {
  const graded = rows.filter((r) => r.state === AttemptState.GRADED && r.graded_at !== null);
  if (graded.length === 0) return { latestExam: null, averageExamScore: null };

  const percentages = graded.map((r) => {
    const max = Number.parseFloat(r.max_score);
    const score = Number.parseFloat(r.score_total ?? '0');
    return max > 0 ? (score / max) * 100 : 0;
  });
  const averageExamScore = roundAverage(
    percentages.reduce((sum, p) => sum + p, 0),
    percentages.length,
  );

  const latest = graded.reduce((a, b) =>
    (b.graded_at ?? new Date(0)) > (a.graded_at ?? new Date(0)) ? b : a,
  );
  const maxScore = Number.parseFloat(latest.max_score);
  const score = Number.parseFloat(latest.score_total ?? '0');

  return {
    averageExamScore,
    latestExam: {
      examName: latest.exam_name,
      score,
      maxScore,
      percentage: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
      passed: latest.passed,
      gradedAt: (latest.graded_at ?? latest.submitted_at ?? latest.started_at).toISOString(),
    },
  };
}

/**
 * Four independent risk signals, each backed by a real aggregate — never a
 * fabricated field. `factors.length` maps to a level: 0 = low, 1 = medium,
 * 2 = high, 3+ = critical. Missing data (e.g. no exams yet) never counts
 * *against* a student — there is simply nothing to flag.
 */
function assessRisk(input: {
  averageExamScore: number | null;
  attendanceRate: number | null;
  homeworkCompletionRate: number | null;
  lateHomeworkCount: number;
  lastActive: Date | null;
  guardian: StudentGuardianSummary | null;
  deliveredCount: number;
  readCount: number;
}): RiskAssessment {
  const factors: string[] = [];

  if (input.averageExamScore !== null && input.averageExamScore < LOW_SCORE_THRESHOLD) {
    factors.push(`Average exam score below ${String(LOW_SCORE_THRESHOLD)}%`);
  }
  if (input.attendanceRate !== null && input.attendanceRate < LOW_ATTENDANCE_THRESHOLD) {
    factors.push(`Attendance below ${String(LOW_ATTENDANCE_THRESHOLD)}%`);
  }
  if (
    input.homeworkCompletionRate !== null &&
    input.homeworkCompletionRate < LOW_ATTENDANCE_THRESHOLD
  ) {
    factors.push(`Homework completion below ${String(LOW_ATTENDANCE_THRESHOLD)}%`);
  } else if (input.lateHomeworkCount > 0) {
    factors.push('Late homework submission');
  }
  if (input.lastActive !== null) {
    const daysSince = (Date.now() - input.lastActive.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSince > INACTIVITY_DAYS) {
      factors.push(`No lesson activity in the last ${String(INACTIVITY_DAYS)} days`);
    }
  }

  if (!input.guardian) {
    factors.push('No guardian linked');
  } else if (input.guardian.verificationStatus !== GuardianVerificationStatus.VERIFIED) {
    factors.push('Guardian not verified');
  } else if (input.guardian.optedOut) {
    factors.push('Guardian opted out of notifications');
  }

  if (input.deliveredCount >= UNREAD_SAMPLE_SIZE && input.readCount === 0) {
    factors.push('Guardian has not read recent notifications');
  }

  const level: RiskLevel =
    factors.length === 0
      ? 'low'
      : factors.length === 1
        ? 'medium'
        : factors.length === 2
          ? 'high'
          : 'critical';

  return { level, factors };
}
