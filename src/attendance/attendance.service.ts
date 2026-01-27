import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { Lesson } from '../lessons/entities/lesson.entity';
import { NotificationTriggersService } from '../notifications/services/notification-triggers.service';
import { AttendanceFilterDto, MarkAttendanceDto } from './dto';
import {
  AttendanceRecord,
  AttendanceStatus,
} from './entities/attendance-record.entity';
import { LessonSession } from './entities/lesson-session.entity';
import { IsNull, Repository } from 'typeorm';

const AUTO_ATTENDANCE_THRESHOLD = 80; // 80% video watch = auto present

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
    private readonly notificationTriggersService: NotificationTriggersService,
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
    const existing = await this.checkAttendanceExists(
      dto.student_id,
      dto.lesson_id,
    );

    if (existing) {
      throw new ConflictException(
        'Attendance already marked for this student and lesson',
      );
    }

    // Validate lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: dto.lesson_id, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${dto.lesson_id} not found`);
    }

    // Create attendance record
    const attendance = this.attendanceRepository.create({
      student_id: dto.student_id,
      lesson_id: dto.lesson_id,
      status: dto.status,
      marked_by: markerId,
      is_auto_marked: isAutoMarked,
      notes:
        dto.notes ??
        (isAutoMarked ? 'Auto-marked: 80% video completion' : null),
    });

    const saved = await this.attendanceRepository.save(attendance);

    this.logger.log(
      `Attendance marked: student ${dto.student_id}, lesson ${dto.lesson_id}, status ${dto.status}, auto=${String(isAutoMarked)}`,
    );

    // Send SMS notification to parent if marked present
    if (dto.status === 'present') {
      try {
        await this.notificationTriggersService.notifyAttendance(
          dto.student_id,
          lesson.title,
          saved.marked_at,
        );
      } catch (error) {
        this.logger.error('Failed to send attendance notification:', error);
      }
    }

    return await this.findAttendanceById(saved.id);
  }

  /**
   * Update existing attendance record
   */
  public async updateAttendance(
    id: string,
    markerId: string,
    status: AttendanceStatus,
    notes?: string,
  ): Promise<AttendanceRecord> {
    const attendance = await this.findAttendanceById(id);

    attendance.status = status;
    attendance.marked_by = markerId;
    attendance.is_auto_marked = false;
    if (notes !== undefined) {
      attendance.notes = notes;
    }

    await this.attendanceRepository.save(attendance);

    this.logger.log(`Attendance updated: ${id} to ${status}`);

    return await this.findAttendanceById(id);
  }

  /**
   * Delete attendance record
   */
  public async deleteAttendance(id: string): Promise<void> {
    const attendance = await this.findAttendanceById(id);
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
      },
    });
  }

  /**
   * Find attendance by ID
   */
  public async findAttendanceById(id: string): Promise<AttendanceRecord> {
    const attendance = await this.attendanceRepository.findOne({
      where: { id },
      relations: ['student', 'lesson', 'marker'],
    });

    if (!attendance) {
      throw new NotFoundException(`Attendance record with ID ${id} not found`);
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
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // Create session
    const session = this.sessionsRepository.create({
      student_id: studentId,
      lesson_id: lessonId,
      ip_address: ipAddress ?? null,
      device_info: deviceInfo ?? null,
    });

    const saved = await this.sessionsRepository.save(session);

    this.logger.log(
      `Session started: student ${studentId}, lesson ${lessonId}`,
    );

    return saved;
  }

  /**
   * End a lesson session and check for auto-attendance
   */
  public async exitLesson(
    sessionId: string,
    watchPercentage: number,
    durationSeconds: number,
  ): Promise<{ session: LessonSession; auto_attendance: boolean }> {
    const session = await this.findSessionById(sessionId);

    // Update session
    session.exited_at = new Date();
    session.video_progress_percent = watchPercentage;
    session.duration_seconds = durationSeconds;

    await this.sessionsRepository.save(session);

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
    watchPercentage: number,
  ): Promise<LessonSession> {
    const session = await this.findSessionById(sessionId);

    session.video_progress_percent = Math.max(
      session.video_progress_percent,
      watchPercentage,
    );

    await this.sessionsRepository.save(session);

    return session;
  }

  /**
   * Check and auto-mark attendance if threshold met
   */
  private async checkAndAutoMarkAttendance(
    session: LessonSession,
  ): Promise<boolean> {
    // Check if already marked
    const existing = await this.checkAttendanceExists(
      session.student_id,
      session.lesson_id,
    );

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
   * Find session by ID
   */
  public async findSessionById(id: string): Promise<LessonSession> {
    const session = await this.sessionsRepository.findOne({
      where: { id },
      relations: ['student', 'lesson'],
    });

    if (!session) {
      throw new NotFoundException(`Session with ID ${id} not found`);
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

    query.orderBy('attendance.marked_at', 'DESC');

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

    query.orderBy('attendance.marked_at', 'DESC');

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

    // Apply filters
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

    query.orderBy('attendance.marked_at', 'DESC');

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
      attendance_rate:
        total > 0 ? Math.round(((present + late) / total) * 100) : 0,
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
      attendance_rate:
        total > 0 ? Math.round(((present + late) / total) * 100) : 0,
    };
  }
}
