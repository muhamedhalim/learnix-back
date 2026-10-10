import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository, type SelectQueryBuilder } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonSessionBookingStatus } from '../lessons/entities/lesson-session-booking-status.enum';
import { LessonSessionBooking } from '../lessons/entities/lesson-session-booking.entity';
import { ScheduledLessonSession } from '../lessons/entities/scheduled-lesson-session.entity';
import { AttendanceMarkedEvent, PARENT_EVENT_CHANNEL } from '../notifications/events/parent-events';
import { PaymentsService } from '../payments/services/payments.service';
import { User } from '../users/entities/user.entity';
import { AttendanceFilterDto, MarkAttendanceDto } from './dto';
import { AttendanceRecord, AttendanceStatus } from './entities/attendance-record.entity';
import { LessonSession } from './entities/lesson-session.entity';

const AUTO_ATTENDANCE_THRESHOLD = 80; // 80% video watch = auto present

/**
 * Rows fetched per database round-trip while streaming an export. Chosen
 * independently of the UI page size (DEF-008): the listing's `limit` is a
 * presentation concern, this is purely a memory/round-trip trade-off. 1000
 * projected rows is a few hundred KB — small enough to hold, large enough that
 * a 100k-row export is 100 queries, not 5000.
 */
export const ATTENDANCE_EXPORT_CHUNK_SIZE = 1000;

// Type interfaces for raw query results
interface AttendanceStatsRaw {
  total: string;
  present: string;
  absent: string;
  late: string;
  excused: string;
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(LessonSession)
    private readonly sessionsRepository: Repository<LessonSession>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(ScheduledLessonSession)
    private readonly scheduledSessionsRepository: Repository<ScheduledLessonSession>,
    @InjectRepository(LessonSessionBooking)
    private readonly scheduledBookingsRepository: Repository<LessonSessionBooking>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly events: EventEmitter2,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Mark attendance manually (teacher/admin)
   */
  public async markAttendance(
    markerId: string | null,
    dto: MarkAttendanceDto,
    isAutoMarked = false,
  ): Promise<AttendanceRecord> {
    // Check if already marked
    const existing = await this.checkAttendanceExists(dto.student_id, dto.lesson_id);

    if (existing) {
      throw new ConflictException(
        biBody(
          'Attendance already marked for this student and lesson',
          'تم تسجيل الحضور لهذا الطالب في هذا الدرس بالفعل',
        ),
      );
    }

    // Validate lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: dto.lesson_id, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(
        biBody(
          `Lesson with ID ${dto.lesson_id} not found`,
          `الدرس ذو المعرف ${dto.lesson_id} غير موجود`,
        ),
      );
    }

    await this.assertStudentEnrollment(dto.student_id, dto.lesson_id);

    // Create attendance record
    const attendance = this.attendanceRepository.create({
      student_id: dto.student_id,
      lesson_id: dto.lesson_id,
      status: dto.status,
      marked_by: markerId,
      is_auto_marked: isAutoMarked,
      notes: dto.notes ?? (isAutoMarked ? 'Auto-marked: 80% video completion' : null),
      scheduled_lesson_session_id: null,
    });

    const saved = await this.attendanceRepository.save(attendance);

    this.logger.log(
      `Attendance marked: student ${dto.student_id}, lesson ${dto.lesson_id}, status ${dto.status}, auto=${String(isAutoMarked)}`,
    );

    // Announce the fact and move on. Previously this awaited a live Twilio HTTP
    // call inside the request, so a slow provider slowed down marking a student
    // present. The listener only enqueues; the worker does the talking.
    if (dto.status === 'present') {
      const student = await this.usersRepository.findOne({ where: { id: dto.student_id } });
      this.events.emit(
        PARENT_EVENT_CHANNEL,
        new AttendanceMarkedEvent(dto.student_id, saved.id, {
          studentName: student?.name ?? '',
          lessonName: lesson.title,
          status: dto.status,
          markedAt: saved.marked_at.toLocaleString('ar-EG', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        }),
      );
    }

    return await this.findAttendanceById(saved.id);
  }

  /** Mark attendance for one confirmed live appointment. */
  public async markScheduledSessionAttendance(
    markerId: string,
    lessonId: string,
    sessionId: string,
    dto: MarkAttendanceDto,
  ): Promise<AttendanceRecord> {
    const session = await this.scheduledSessionsRepository.findOne({
      where: { id: sessionId, lesson_id: lessonId },
      relations: ['lesson'],
    });
    if (!session) {
      throw new NotFoundException(
        biBody('Scheduled lesson session not found', 'موعد الدرس غير موجود'),
      );
    }

    const booking = await this.scheduledBookingsRepository.findOne({
      where: {
        scheduled_session_id: sessionId,
        student_id: dto.student_id,
        status: LessonSessionBookingStatus.CONFIRMED,
      },
    });
    if (!booking) {
      throw new ForbiddenException(
        biBody(
          'Only the confirmed student can receive attendance for this appointment',
          'يمكن تسجيل الحضور للطالب المؤكد لهذا الموعد فقط',
        ),
      );
    }

    // Existence only (the real guard is UQ_attendance_student_scheduled_session). `attendance_records` has no
    // `deleted_at`, so the where stays exactly the pair.
    const alreadyMarked = await this.attendanceRepository.exists({
      where: {
        student_id: dto.student_id,
        scheduled_lesson_session_id: sessionId,
      },
    });
    if (alreadyMarked) {
      throw new ConflictException(
        biBody('Attendance already marked for this appointment', 'تم تسجيل الحضور لهذا الموعد بالفعل'),
      );
    }

    const attendance = this.attendanceRepository.create({
      student_id: dto.student_id,
      lesson_id: lessonId,
      scheduled_lesson_session_id: sessionId,
      status: dto.status,
      marked_by: markerId,
      is_auto_marked: false,
      notes: dto.notes ?? null,
    });
    const saved = await this.attendanceRepository.save(attendance);
    this.logger.log(
      `Scheduled attendance marked: student ${dto.student_id}, session ${sessionId}, status ${dto.status}`,
    );
    return await this.findAttendanceById(saved.id);
  }

  /**
   * Update existing attendance record
   */
  public async updateAttendance(
    id: string,
    lessonId: string,
    markerId: string,
    status: AttendanceStatus,
    notes?: string,
  ): Promise<AttendanceRecord> {
    const attendance = await this.findAttendanceByIdForLesson(id, lessonId);

    attendance.status = status;
    attendance.marked_by = markerId;
    attendance.is_auto_marked = false;
    if (notes !== undefined) {
      attendance.notes = notes;
    }

    await this.attendanceRepository.save(attendance);

    this.logger.log(`Attendance updated: ${id} to ${status}`);

    return await this.findAttendanceByIdForLesson(id, lessonId);
  }

  /**
   * Delete attendance record
   */
  public async deleteAttendance(id: string, lessonId: string): Promise<void> {
    const attendance = await this.findAttendanceByIdForLesson(id, lessonId);
    await this.attendanceRepository.remove(attendance);
    this.logger.log(`Attendance deleted: ${id}`);
  }

  /**
   * Check if attendance already exists
   */
  public async checkAttendanceExists(
    studentId: string,
    lessonId: string,
  ): Promise<AttendanceRecord | null> {
    return await this.attendanceRepository.findOne({
      where: {
        student_id: studentId,
        lesson_id: lessonId,
        scheduled_lesson_session_id: IsNull(),
      },
    });
  }

  /**
   * Find attendance by ID
   */
  public async findAttendanceById(id: string): Promise<AttendanceRecord> {
    const attendance = await this.attendanceRepository.findOne({
      where: { id },
      relations: ['student', 'lesson', 'marker', 'scheduled_lesson_session'],
    });

    if (!attendance) {
      throw new NotFoundException(
        biBody(`Attendance record with ID ${id} not found`, `سجل الحضور ذو المعرف ${id} غير موجود`),
      );
    }

    return attendance;
  }

  /**
   * Resolve an attendance record only when it belongs to the lesson selected
   * by the teacher route. Keeping this predicate in the lookup prevents a
   * valid teacher-owned lesson id from being used to mutate a record from a
   * different lesson.
   */
  public async findAttendanceByIdForLesson(
    id: string,
    lessonId: string,
  ): Promise<AttendanceRecord> {
    const attendance = await this.attendanceRepository.findOne({
      where: { id, lesson_id: lessonId },
      relations: ['student', 'lesson', 'marker'],
    });

    if (!attendance) {
      throw new NotFoundException(
        biBody(
          `Attendance record with ID ${id} was not found for this lesson`,
          `سجل الحضور ذو المعرف ${id} غير موجود لهذا الدرس`,
        ),
      );
    }

    return attendance;
  }

  /**
   * Start a lesson session (track video watch)
   */
  public async enterLesson(
    studentId: string,
    lessonId: string,
    ipAddress?: string,
    deviceInfo?: string,
  ): Promise<LessonSession> {
    // Validate lesson exists
    const lessonExists = await this.lessonsRepository.exists({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lessonExists) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس ذو المعرف ${lessonId} غير موجود`),
      );
    }

    await this.assertStudentEnrollment(studentId, lessonId);

    // Create session
    const session = this.sessionsRepository.create({
      student_id: studentId,
      lesson_id: lessonId,
      ip_address: ipAddress ?? null,
      device_info: deviceInfo ?? null,
    });

    const saved = await this.sessionsRepository.save(session);

    this.logger.log(`Session started: student ${studentId}, lesson ${lessonId}`);

    return saved;
  }

  /**
   * End a lesson session and check for auto-attendance.
   *
   * When the caller already holds the owner-scoped active session (the exit route does,
   * via `findActiveSession(studentId, lessonId)`), pass it as `activeSession`: the session
   * is closed with a single UPDATE and no relation joins, and the result carries scalar
   * `lesson_sessions` columns only. Without it the session is loaded by id as before.
   */
  public async exitLesson(
    sessionId: string,
    watchPercentage: number,
    durationSeconds: number,
    activeSession?: LessonSession,
  ): Promise<{ session: LessonSession; auto_attendance: boolean }> {
    const session = activeSession ?? (await this.findSessionById(sessionId));

    // Update session
    session.exited_at = new Date();
    session.video_progress_percent = watchPercentage;
    session.duration_seconds = durationSeconds;

    if (activeSession) {
      await this.sessionsRepository.update(
        { id: session.id },
        {
          exited_at: session.exited_at,
          video_progress_percent: watchPercentage,
          duration_seconds: durationSeconds,
        },
      );
    } else {
      await this.sessionsRepository.save(session);
    }

    const isCompleted = watchPercentage >= AUTO_ATTENDANCE_THRESHOLD;
    this.logger.log(
      `Session ended: ${sessionId}, watch ${String(watchPercentage)}%, completed=${String(isCompleted)}`,
    );

    // Check for auto-attendance
    let autoAttendance = false;
    if (isCompleted) {
      autoAttendance = await this.checkAndAutoMarkAttendance(session);
    }

    return { session, auto_attendance: autoAttendance };
  }

  /**
   * Update session progress (during playback)
   */
  public async updateSessionProgress(
    sessionId: string,
    studentId: string,
    watchPercentage: number,
  ): Promise<LessonSession> {
    const session = await this.findSessionByIdForStudent(sessionId, studentId);

    session.video_progress_percent = Math.max(session.video_progress_percent, watchPercentage);

    await this.sessionsRepository.save(session);

    return session;
  }

  /**
   * Check and auto-mark attendance if threshold met
   */
  private async checkAndAutoMarkAttendance(session: LessonSession): Promise<boolean> {
    // Check if already marked
    const existing = await this.checkAttendanceExists(session.student_id, session.lesson_id);

    if (existing) {
      this.logger.log(
        `Auto-attendance skipped: already marked for student ${session.student_id}, lesson ${session.lesson_id}`,
      );
      return false;
    }

    // Auto-mark as present
    try {
      await this.markAttendance(
        null,
        {
          student_id: session.student_id,
          lesson_id: session.lesson_id,
          status: 'present',
          notes: `Auto-marked: ${String(session.video_progress_percent)}% video completion`,
        },
        true,
      );

      this.logger.log(
        `Auto-attendance marked: student ${session.student_id}, lesson ${session.lesson_id}`,
      );

      return true;
    } catch (error) {
      this.logger.error('Failed to auto-mark attendance:', error);
      return false;
    }
  }

  /**
   * Attendance is a record of access to paid instructional content. Reuse the
   * canonical payments entitlement policy so direct lesson purchases and
   * active package enrolments are both accepted, while arbitrary students can
   * never create attendance records or playback sessions for another course.
   */
  private async assertStudentEnrollment(studentId: string, lessonId: string): Promise<void> {
    const hasEnrollment = await this.paymentsService.hasLessonPlaybackAccess(studentId, lessonId);
    if (!hasEnrollment) {
      throw new ForbiddenException(
        biBody(
          'The student does not have an active enrollment for this lesson',
          'الطالب لا يملك تسجيلاً نشطاً لهذا الدرس',
        ),
      );
    }
  }

  /**
   * Find session by ID
   */
  public async findSessionById(id: string): Promise<LessonSession> {
    const session = await this.sessionsRepository.findOne({
      where: { id },
      relations: ['student', 'lesson'],
    });

    if (!session) {
      throw new NotFoundException(
        biBody(`Session with ID ${id} not found`, `الجلسة ذات المعرف ${id} غير موجودة`),
      );
    }

    return session;
  }

  /** Resolve a playback session only for its owning student. */
  public async findSessionByIdForStudent(id: string, studentId: string): Promise<LessonSession> {
    const session = await this.sessionsRepository.findOne({
      where: { id, student_id: studentId },
      relations: ['student', 'lesson'],
    });
    if (!session) {
      throw new NotFoundException(
        biBody(`Session with ID ${id} not found`, `الجلسة ذات المعرّف ${id} غير موجودة`),
      );
    }
    return session;
  }

  /**
   * Find active session for student in lesson
   */
  public async findActiveSession(
    studentId: string,
    lessonId: string,
  ): Promise<LessonSession | null> {
    return await this.sessionsRepository.findOne({
      where: {
        student_id: studentId,
        lesson_id: lessonId,
        exited_at: IsNull(),
      },
      order: { entered_at: 'DESC' },
    });
  }

  /**
   * Get student's attendance history
   */
  public async getStudentAttendance(
    studentId: string,
    filter: AttendanceFilterDto,
  ): Promise<{ data: AttendanceRecord[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const query = this.attendanceRepository
      .createQueryBuilder('attendance')
      .leftJoinAndSelect('attendance.lesson', 'lesson')
      .leftJoinAndSelect('lesson.teacher', 'teacher')
      .leftJoinAndSelect('lesson.subject', 'subject')
      .where('attendance.student_id = :studentId', { studentId });

    // Apply filters
    if (typeof filter.lesson_id === 'string' && filter.lesson_id !== '') {
      query.andWhere('attendance.lesson_id = :lessonId', {
        lessonId: filter.lesson_id,
      });
    }

    if (filter.status !== undefined) {
      query.andWhere('attendance.status = :status', { status: filter.status });
    }

    if (typeof filter.from_date === 'string' && filter.from_date !== '') {
      query.andWhere('attendance.marked_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (typeof filter.to_date === 'string' && filter.to_date !== '') {
      query.andWhere('attendance.marked_at <= :toDate', {
        toDate: filter.to_date,
      });
    }

    query.orderBy('attendance.marked_at', 'DESC').addOrderBy('attendance.id', 'DESC');

    const total = await query.getCount();

    query.skip(skip).take(limit);

    const records = await query.getMany();

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: records, meta };
  }

  /**
   * Get attendance for a lesson (teacher view)
   */
  public async getLessonAttendance(
    lessonId: string,
    filter: AttendanceFilterDto,
  ): Promise<{ data: AttendanceRecord[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 50;
    const skip = (page - 1) * limit;

    const query = this.attendanceRepository
      .createQueryBuilder('attendance')
      .leftJoinAndSelect('attendance.student', 'student')
      .leftJoinAndSelect('attendance.marker', 'marker')
      .where('attendance.lesson_id = :lessonId', { lessonId });

    // Apply filters
    if (filter.status !== undefined) {
      query.andWhere('attendance.status = :status', { status: filter.status });
    }

    if (typeof filter.from_date === 'string' && filter.from_date !== '') {
      query.andWhere('attendance.marked_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (typeof filter.to_date === 'string' && filter.to_date !== '') {
      query.andWhere('attendance.marked_at <= :toDate', {
        toDate: filter.to_date,
      });
    }

    query.orderBy('attendance.marked_at', 'DESC').addOrderBy('attendance.id', 'DESC');

    const total = await query.getCount();

    query.skip(skip).take(limit);

    const records = await query.getMany();

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: records, meta };
  }

  /**
   * Get all attendance (admin view)
   */
  public async getAllAttendance(
    filter: AttendanceFilterDto,
  ): Promise<{ data: AttendanceRecord[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const query = this.attendanceRepository
      .createQueryBuilder('attendance')
      .leftJoinAndSelect('attendance.student', 'student')
      .leftJoinAndSelect('attendance.lesson', 'lesson')
      .leftJoinAndSelect('lesson.teacher', 'teacher')
      .leftJoinAndSelect('attendance.marker', 'marker');

    this.applyAdminAttendanceFilters(query, filter);
    this.orderAdminAttendance(query);

    const total = await query.getCount();

    query.skip(skip).take(limit);

    const records = await query.getMany();

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: records, meta };
  }

  /**
   * The one place admin attendance filters are turned into SQL, shared by the
   * paginated listing and by the export (DEF-008). A filter added here changes
   * both surfaces at once — the two can never disagree about what "matching"
   * means, which is what makes an exported row count trustworthy.
   */
  private applyAdminAttendanceFilters(
    query: SelectQueryBuilder<AttendanceRecord>,
    filter: AttendanceFilterDto,
  ): void {
    if (typeof filter.student_id === 'string' && filter.student_id !== '') {
      query.andWhere('attendance.student_id = :studentId', {
        studentId: filter.student_id,
      });
    }

    if (typeof filter.lesson_id === 'string' && filter.lesson_id !== '') {
      query.andWhere('attendance.lesson_id = :lessonId', {
        lessonId: filter.lesson_id,
      });
    }

    if (filter.status !== undefined) {
      query.andWhere('attendance.status = :status', { status: filter.status });
    }

    if (typeof filter.from_date === 'string' && filter.from_date !== '') {
      query.andWhere('attendance.marked_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (typeof filter.to_date === 'string' && filter.to_date !== '') {
      query.andWhere('attendance.marked_at <= :toDate', {
        toDate: filter.to_date,
      });
    }
  }

  /**
   * The canonical admin attendance ordering: newest first, with the primary
   * key as tiebreaker. The id tiebreaker is what makes the order a TOTAL one —
   * `marked_at` alone is not unique (bulk marking stamps many rows in the same
   * millisecond), and without it the export's chunk boundaries could skip or
   * repeat rows that share a timestamp.
   */
  private orderAdminAttendance(query: SelectQueryBuilder<AttendanceRecord>): void {
    query.orderBy('attendance.marked_at', 'DESC').addOrderBy('attendance.id', 'DESC');
  }

  /* ===================== Export (DEF-008) ===================== */

  /** How many rows the export will contain — the same filters as the listing. */
  public countAttendanceForExport(filter: AttendanceFilterDto): Promise<number> {
    const query = this.attendanceRepository.createQueryBuilder('attendance');
    this.applyAdminAttendanceFilters(query, filter);
    return query.getCount();
  }

  /**
   * The complete filtered result set, yielded in bounded chunks.
   *
   * Uses KEYSET (cursor) iteration on the canonical `(marked_at DESC, id DESC)`
   * order rather than OFFSET: each chunk asks for rows strictly "after" the
   * last row of the previous one, so chunk boundaries cannot skip or duplicate
   * a record even when many rows share a `marked_at`, and the cost of reaching
   * chunk N does not grow with N.
   *
   * Selects only the columns the exporter renders and joins the two relations
   * it needs once, so there is no N+1 and no needless payload per row.
   * `page`/`limit` on the filter are deliberately ignored: UI pagination is not
   * an export bound (that was the DEF-008 defect).
   */
  public async *iterateAttendanceForExport(
    filter: AttendanceFilterDto,
    chunkSize = ATTENDANCE_EXPORT_CHUNK_SIZE,
  ): AsyncGenerator<AttendanceRecord[]> {
    let cursor: { markedAt: Date; id: string } | null = null;

    for (;;) {
      const query = this.attendanceRepository
        .createQueryBuilder('attendance')
        .leftJoin('attendance.student', 'student')
        .leftJoin('attendance.lesson', 'lesson')
        .leftJoin('lesson.teacher', 'teacher')
        .select([
          'attendance.id',
          'attendance.student_id',
          'attendance.lesson_id',
          'attendance.status',
          'attendance.is_auto_marked',
          'attendance.notes',
          'attendance.marked_at',
          'student.name',
          'student.email',
          'lesson.title',
          'teacher.name',
        ]);
      this.applyAdminAttendanceFilters(query, filter);
      if (cursor) {
        query.andWhere(
          '(attendance.marked_at, attendance.id) < (:cursorMarkedAt, :cursorId)',
          { cursorMarkedAt: cursor.markedAt, cursorId: cursor.id },
        );
      }
      this.orderAdminAttendance(query);
      const chunk = await query.take(chunkSize).getMany();
      if (chunk.length === 0) return;

      yield chunk;
      if (chunk.length < chunkSize) return;
      const last = chunk[chunk.length - 1]!;
      cursor = { markedAt: new Date(last.marked_at), id: last.id };
    }
  }

  /**
   * Get student attendance statistics
   */
  public async getStudentAttendanceStats(studentId: string): Promise<{
    total: number;
    present: number;
    absent: number;
    late: number;
    excused: number;
    attendance_rate: number;
  }> {
    const result = await this.attendanceRepository
      .createQueryBuilder('attendance')
      .where('attendance.student_id = :studentId', { studentId })
      .select([
        'COUNT(*) as total',
        "SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present",
        "SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent",
        "SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late",
        "SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) as excused",
      ])
      .getRawOne<AttendanceStatsRaw>();

    const total = result ? Number(result.total) : 0;
    const present = result ? Number(result.present) : 0;
    const late = result ? Number(result.late) : 0;

    return {
      total,
      present,
      absent: result ? Number(result.absent) : 0,
      late,
      excused: result ? Number(result.excused) : 0,
      attendance_rate: total > 0 ? Math.round(((present + late) / total) * 100) : 0,
    };
  }

  /**
   * Get lesson attendance statistics
   */
  public async getLessonAttendanceStats(lessonId: string): Promise<{
    total: number;
    present: number;
    absent: number;
    late: number;
    excused: number;
    attendance_rate: number;
  }> {
    const result = await this.attendanceRepository
      .createQueryBuilder('attendance')
      .where('attendance.lesson_id = :lessonId', { lessonId })
      .select([
        'COUNT(*) as total',
        "SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present",
        "SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent",
        "SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late",
        "SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) as excused",
      ])
      .getRawOne<AttendanceStatsRaw>();

    const total = result ? Number(result.total) : 0;
    const present = result ? Number(result.present) : 0;
    const late = result ? Number(result.late) : 0;

    return {
      total,
      present,
      absent: result ? Number(result.absent) : 0,
      late,
      excused: result ? Number(result.excused) : 0,
      attendance_rate: total > 0 ? Math.round(((present + late) / total) * 100) : 0,
    };
  }
}
