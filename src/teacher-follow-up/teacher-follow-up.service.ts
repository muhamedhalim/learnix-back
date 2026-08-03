import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import { ParentEventType } from '../common/events/parent-event-type.enum';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { HomeworkSubmission } from '../lessons/entities/homework-submission.entity';
import { LessonHomework } from '../lessons/entities/lesson-homework.entity';
import { AttemptState } from '../exams/entities/attempt-state.enum';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { GuardianVerificationStatus, StudentGuardian } from '../guardians/entities';
import { ParentMessage } from '../notifications/entities';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
import { ParentMessageAdminService } from '../notifications/services/parent-message-admin.service';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { biBody } from '../i18n/error-translator.util';
import { User } from '../users/entities/user.entity';
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

  /** Every student who has purchased at least one of this teacher's lessons or packages. */
  public async getOwnedStudentIds(teacherId: string): Promise<string[]> {
    const [viaLessons, viaPackages] = await Promise.all([
      this.lessonPurchases
        .createQueryBuilder('lp')
        .innerJoin('lp.lesson', 'lesson')
        .where('lesson.teacher_id = :teacherId', { teacherId })
        .distinct(true)
        .select('lp.student_id', 'student_id')
        .getRawMany<{ student_id: string }>(),
      this.packagePurchases
        .createQueryBuilder('pp')
        .innerJoin('pp.package', 'package')
        .innerJoin('package.items', 'items')
        .innerJoin('items.lesson', 'lesson')
        .where('lesson.teacher_id = :teacherId', { teacherId })
        .distinct(true)
        .select('pp.student_id', 'student_id')
        .getRawMany<{ student_id: string }>(),
    ]);

    const ids = new Set<string>();
    for (const row of viaLessons) ids.add(row.student_id);
    for (const row of viaPackages) ids.add(row.student_id);
    return [...ids];
  }

  /** Throws 403 unless `studentId` has ever purchased something from `teacherId`. */
  public async assertOwnsStudent(teacherId: string, studentId: string): Promise<void> {
    const [lessonCount, packageCount] = await Promise.all([
      this.lessonPurchases
        .createQueryBuilder('lp')
        .innerJoin('lp.lesson', 'lesson')
        .where('lesson.teacher_id = :teacherId', { teacherId })
        .andWhere('lp.student_id = :studentId', { studentId })
        .getCount(),
      this.packagePurchases
        .createQueryBuilder('pp')
        .innerJoin('pp.package', 'package')
        .innerJoin('package.items', 'items')
        .innerJoin('items.lesson', 'lesson')
        .where('lesson.teacher_id = :teacherId', { teacherId })
        .andWhere('pp.student_id = :studentId', { studentId })
        .getCount(),
    ]);

    if (lessonCount === 0 && packageCount === 0) {
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

    const ownedIds = await this.getOwnedStudentIds(teacherId);
    if (ownedIds.length === 0) {
      return { data: [], total: 0, page, limit };
    }

    const qb = this.users
      .createQueryBuilder('u')
      .where('u.id IN (:...ownedIds)', { ownedIds })
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
    const pageIds = students.map((s) => s.id);
    const summaries = await this.buildSummaries(teacherId, pageIds);

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
    const summaries = await this.buildSummaries(teacherId, [studentId]);
    return summaries.get(studentId) ?? this.emptySummary(student);
  }

  /**
   * Guardian/notification/risk figures for the teacher analytics extension.
   * Reuses `ParentMessageAdminService.stats` (the same delivery/read-rate
   * math the admin dashboard uses) and `buildSummaries` (the same risk
   * assessment the roster uses) rather than recomputing either.
   */
  public async getAnalyticsSummary(teacherId: string): Promise<{
    guardians: { total: number; verified: number; pending: number };
    notifications: { today: number; deliveryRate: number; readRate: number };
    riskStudentCount: number;
  }> {
    const ownedIds = await this.getOwnedStudentIds(teacherId);
    if (ownedIds.length === 0) {
      return {
        guardians: { total: 0, verified: 0, pending: 0 },
        notifications: { today: 0, deliveryRate: 0, readRate: 0 },
        riskStudentCount: 0,
      };
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [guardianRows, todayCount, messageStats, summaries] = await Promise.all([
      this.studentGuardians
        .createQueryBuilder('sg')
        .innerJoin('sg.guardian', 'g')
        .where('sg.student_id IN (:...ownedIds)', { ownedIds })
        .andWhere('g.deleted_at IS NULL')
        .distinct(true)
        .select('g.id', 'id')
        .addSelect('g.verification_status', 'status')
        .getRawMany<{ id: string; status: GuardianVerificationStatus }>(),
      this.parentMessages
        .createQueryBuilder('m')
        .where('m.student_id IN (:...ownedIds)', { ownedIds })
        .andWhere('m.created_at >= :startOfToday', { startOfToday })
        .getCount(),
      this.parentMessageAdmin.stats(ownedIds),
      this.buildSummaries(teacherId, ownedIds),
    ]);

    const verified = guardianRows.filter(
      (r) => r.status === GuardianVerificationStatus.VERIFIED,
    ).length;
    const riskStudentCount = [...summaries.values()].filter((s) => s.risk.level !== 'low').length;

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
    studentIds: string[],
  ): Promise<Map<string, TeacherStudentSummary>> {
    const students = await this.users.find({ where: { id: In(studentIds) } });

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
      .andWhere('a.student_id IN (:...studentIds)', { studentIds })
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
      .andWhere('rec.student_id IN (:...studentIds)', { studentIds })
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
      .andWhere('submission.student_id IN (:...studentIds)', { studentIds })
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
      `
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
          ON lesson.id = homework.lesson_id AND lesson.teacher_id = $1 AND lesson.deleted_at IS NULL
        LEFT JOIN homework_submissions submission
          ON submission.homework_id = homework.id AND submission.student_id = student.id
        WHERE student.id = ANY($2::uuid[])
          AND (
            EXISTS (
              SELECT 1 FROM lesson_purchases lp
              WHERE lp.student_id = student.id
                AND lp.lesson_id = homework.lesson_id
                AND lp.revoked_at IS NULL
                AND lp.access_expires_at > NOW()
            ) OR EXISTS (
              SELECT 1 FROM package_purchases pp
              INNER JOIN lesson_package_items item ON item.package_id = pp.package_id
              WHERE pp.student_id = student.id AND item.lesson_id = homework.lesson_id
                AND pp.revoked_at IS NULL
            )
          )
        GROUP BY student.id
      `,
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
      .andWhere('s.student_id IN (:...studentIds)', { studentIds })
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
      .where('sg.student_id IN (:...studentIds)', { studentIds })
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
      .where('m.student_id IN (:...studentIds)', { studentIds })
      .andWhere('m.event_type IN (:...eventTypes)', {
        eventTypes: [ParentEventType.EXAM_GRADED, ParentEventType.ATTENDANCE_MARKED],
      })
      // idempotency_key is `<event_type>:<subjectId>:<guardianId>` — extracting
      // the subject id is how we prove this message is about *this teacher's*
      // exam/attendance record, not another teacher's, for a shared student.
      .andWhere("split_part(m.idempotency_key, ':', 2) IN (:...subjectIds)", { subjectIds })
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
    const [attempts, attendance] = await Promise.all([
      this.fetchAttemptRows(teacherId, [studentId]),
      this.fetchAttendanceRows(teacherId, [studentId]),
    ]);
    const subjectIds = [...attempts.map((r) => r.id), ...attendance.map((r) => r.id)];
    const byStudent = await this.fetchScopedMessages([studentId], subjectIds);
    return byStudent.get(studentId) ?? [];
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
  const averageExamScore =
    Math.round((percentages.reduce((sum, p) => sum + p, 0) / percentages.length) * 100) / 100;

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
