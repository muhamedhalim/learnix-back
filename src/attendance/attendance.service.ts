import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  AttendanceRecord,
  AttendanceStatus,
} from './entities/attendance-record.entity';
import { LessonSession } from './entities/lesson-session.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { MarkAttendanceDto, AttendanceFilterDto } from './dto';
import { NotificationTriggersService } from '../notifications/services/notification-triggers.service';
import { PaginationMeta } from '../common/interfaces/pagination.interface';

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
  async markAttendance(
    markerId: number | null,
    dto: MarkAttendanceDto,
    isAutoMarked: boolean = false,
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
        dto.notes ||
        (isAutoMarked ? 'Auto-marked: 80% video completion' : null),
    });

    const saved = await this.attendanceRepository.save(attendance);

    this.logger.log(
      `Attendance marked: student ${dto.student_id}, lesson ${dto.lesson_id}, status ${dto.status}, auto=${isAutoMarked}`,
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

    return this.findAttendanceById(saved.id);
  }

  /**
   * Update existing attendance record
   */
  async updateAttendance(
    id: number,
    markerId: number,
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

    return this.findAttendanceById(id);
  }

  /**
   * Delete attendance record
   */
  async deleteAttendance(id: number): Promise<void> {
    const attendance = await this.findAttendanceById(id);
    await this.attendanceRepository.remove(attendance);
    this.logger.log(`Attendance deleted: ${id}`);
  }

  /**
   * Check if attendance already exists
   */
  async checkAttendanceExists(
    studentId: number,
    lessonId: number,
  ): Promise<AttendanceRecord | null> {
    return this.attendanceRepository.findOne({
      where: {
        student_id: studentId,
        lesson_id: lessonId,
      },
    });
  }

  /**
   * Find attendance by ID
   */
  async findAttendanceById(id: number): Promise<AttendanceRecord> {
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
  async enterLesson(
    studentId: number,
    lessonId: number,
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
      ip_address: ipAddress || null,
      device_info: deviceInfo || null,
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
  async exitLesson(
    sessionId: number,
    watchPercentage: number,
    durationSeconds: number,
  ): Promise<{ session: LessonSession; auto_attendance: boolean }> {
    const session = await this.findSessionById(sessionId);

    // Update session
    session.exited_at = new Date();
    session.watch_percentage = watchPercentage;
    session.duration_seconds = durationSeconds;
    session.is_completed = watchPercentage >= AUTO_ATTENDANCE_THRESHOLD;

    await this.sessionsRepository.save(session);

    this.logger.log(
      `Session ended: ${sessionId}, watch ${watchPercentage}%, completed=${session.is_completed}`,
    );

    // Check for auto-attendance
    let autoAttendance = false;
    if (session.is_completed) {
      autoAttendance = await this.checkAndAutoMarkAttendance(session);
    }

    return { session, auto_attendance: autoAttendance };
  }

  /**
   * Update session progress (during playback)
   */
  async updateSessionProgress(
    sessionId: number,
    watchPercentage: number,
  ): Promise<LessonSession> {
    const session = await this.findSessionById(sessionId);

    session.watch_percentage = Math.max(
      Number(session.watch_percentage),
      watchPercentage,
    );
    session.is_completed =
      session.watch_percentage >= AUTO_ATTENDANCE_THRESHOLD;

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
          notes: `Auto-marked: ${session.watch_percentage}% video completion`,
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
  async findSessionById(id: number): Promise<LessonSession> {
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
  async findActiveSession(
    studentId: number,
    lessonId: number,
  ): Promise<LessonSession | null> {
    return this.sessionsRepository.findOne({
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
  async getStudentAttendance(
    studentId: number,
    filter: AttendanceFilterDto,
  ): Promise<{ data: AttendanceRecord[]; meta: PaginationMeta }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const query = this.attendanceRepository
      .createQueryBuilder('attendance')
      .leftJoinAndSelect('attendance.lesson', 'lesson')
      .leftJoinAndSelect('lesson.teacher', 'teacher')
      .leftJoinAndSelect('lesson.subject', 'subject')
      .where('attendance.student_id = :studentId', { studentId });

    // Apply filters
    if (filter.lesson_id) {
      query.andWhere('attendance.lesson_id = :lessonId', {
        lessonId: filter.lesson_id,
      });
    }

    if (filter.status) {
      query.andWhere('attendance.status = :status', { status: filter.status });
    }

    if (filter.from_date) {
      query.andWhere('attendance.marked_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (filter.to_date) {
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
  async getLessonAttendance(
    lessonId: number,
    filter: AttendanceFilterDto,
  ): Promise<{ data: AttendanceRecord[]; meta: PaginationMeta }> {
    const page = filter.page || 1;
    const limit = filter.limit || 50;
    const skip = (page - 1) * limit;

    const query = this.attendanceRepository
      .createQueryBuilder('attendance')
      .leftJoinAndSelect('attendance.student', 'student')
      .leftJoinAndSelect('attendance.marker', 'marker')
      .where('attendance.lesson_id = :lessonId', { lessonId });

    // Apply filters
    if (filter.status) {
      query.andWhere('attendance.status = :status', { status: filter.status });
    }

    if (filter.from_date) {
      query.andWhere('attendance.marked_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (filter.to_date) {
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
  async getAllAttendance(
    filter: AttendanceFilterDto,
  ): Promise<{ data: AttendanceRecord[]; meta: PaginationMeta }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const query = this.attendanceRepository
      .createQueryBuilder('attendance')
      .leftJoinAndSelect('attendance.student', 'student')
      .leftJoinAndSelect('attendance.lesson', 'lesson')
      .leftJoinAndSelect('lesson.teacher', 'teacher')
      .leftJoinAndSelect('attendance.marker', 'marker');

    // Apply filters
    if (filter.student_id) {
      query.andWhere('attendance.student_id = :studentId', {
        studentId: filter.student_id,
      });
    }

    if (filter.lesson_id) {
      query.andWhere('attendance.lesson_id = :lessonId', {
        lessonId: filter.lesson_id,
      });
    }

    if (filter.status) {
      query.andWhere('attendance.status = :status', { status: filter.status });
    }

    if (filter.from_date) {
      query.andWhere('attendance.marked_at >= :fromDate', {
        fromDate: filter.from_date,
      });
    }

    if (filter.to_date) {
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
  async getStudentAttendanceStats(studentId: number): Promise<{
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

    const total = Number(result?.total) || 0;
    const present = Number(result?.present) || 0;
    const late = Number(result?.late) || 0;

    return {
      total,
      present,
      absent: Number(result?.absent) || 0,
      late,
      excused: Number(result?.excused) || 0,
      attendance_rate:
        total > 0 ? Math.round(((present + late) / total) * 100) : 0,
    };
  }

  /**
   * Get lesson attendance statistics
   */
  async getLessonAttendanceStats(lessonId: number): Promise<{
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

    const total = Number(result?.total) || 0;
    const present = Number(result?.present) || 0;
    const late = Number(result?.late) || 0;

    return {
      total,
      present,
      absent: Number(result?.absent) || 0,
      late,
      excused: Number(result?.excused) || 0,
      attendance_rate:
        total > 0 ? Math.round(((present + late) / total) * 100) : 0,
    };
  }
}
