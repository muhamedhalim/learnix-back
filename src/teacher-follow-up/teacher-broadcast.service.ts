import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { randomUUID } from 'node:crypto';
import { In, IsNull, Repository } from 'typeorm';

import { ParentEventType } from '../common/events/parent-event-type.enum';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { AttemptState } from '../exams/entities/attempt-state.enum';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { GuardiansService } from '../guardians/guardians.service';
import { Lesson } from '../lessons/entities/lesson.entity';
import { PARENT_EVENT_CHANNEL, TeacherMessageEvent } from '../notifications/events/parent-events';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { biBody } from '../i18n/error-translator.util';
import { User } from '../users/entities/user.entity';
import { BroadcastScope, TeacherBroadcastDto } from './dto/teacher-broadcast.dto';

/** Same threshold `TeacherFollowUpService` uses for the "low grades" risk factor. */
const LOW_SCORE_THRESHOLD = 60;

export interface BroadcastRecipientPreview {
  studentId: string;
  studentName: string;
  willReceive: boolean;
  reason?: string;
  sampleMessage?: string;
}

export interface BroadcastPreview {
  recipients: BroadcastRecipientPreview[];
  totalStudents: number;
  studentsReachable: number;
}

/**
 * Manual teacher-initiated messages to guardians. Reuses the exact same
 * pipeline every domain event uses — `TeacherMessageEvent` on the shared
 * event bus, delivered by the existing worker — rather than a bespoke
 * "send now" code path. `homework_defaulters` is intentionally not a scope:
 * see `BroadcastScope` for why.
 */
@Injectable()
export class TeacherBroadcastService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
    @InjectRepository(LessonPurchase) private readonly lessonPurchases: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchases: Repository<PackagePurchase>,
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRecords: Repository<AttendanceRecord>,
    @InjectRepository(ExamAttempt) private readonly examAttempts: Repository<ExamAttempt>,
    private readonly guardians: GuardiansService,
    private readonly events: EventEmitter2,
  ) {}

  public async preview(teacherId: string, dto: TeacherBroadcastDto): Promise<BroadcastPreview> {
    const studentIds = await this.resolveTargets(teacherId, dto);
    const students = await this.users.find({ where: { id: In(studentIds) } });
    const teacher = await this.users.findOneOrFail({ where: { id: teacherId } });

    const recipients: BroadcastRecipientPreview[] = [];
    for (const student of students) {
      const targets = await this.guardians.findNotificationTargets(
        student.id,
        ParentEventType.TEACHER_MESSAGE,
      );
      if (targets.length === 0) {
        recipients.push({
          studentId: student.id,
          studentName: student.name,
          willReceive: false,
          reason: 'No verified, opted-in guardian',
        });
        continue;
      }
      recipients.push({
        studentId: student.id,
        studentName: student.name,
        willReceive: true,
        sampleMessage: `Message from ${teacher.name} about ${student.name}:\n\n${dto.message}`,
      });
    }

    return {
      recipients,
      totalStudents: students.length,
      studentsReachable: recipients.filter((r) => r.willReceive).length,
    };
  }

  /**
   * Emits one `TeacherMessageEvent` per targeted student. Each gets its own
   * random subject id — a broadcast is a deliberate, one-off teacher action,
   * never deduplicated the way a re-graded exam is.
   */
  public async send(teacherId: string, dto: TeacherBroadcastDto): Promise<{ queued: number }> {
    const studentIds = await this.resolveTargets(teacherId, dto);
    const students = await this.users.find({ where: { id: In(studentIds) } });
    const teacher = await this.users.findOneOrFail({ where: { id: teacherId } });

    for (const student of students) {
      this.events.emit(
        PARENT_EVENT_CHANNEL,
        new TeacherMessageEvent(student.id, randomUUID(), {
          studentName: student.name,
          teacherName: teacher.name,
          message: dto.message,
        }),
      );
    }

    return { queued: students.length };
  }

  private async resolveTargets(teacherId: string, dto: TeacherBroadcastDto): Promise<string[]> {
    switch (dto.scope) {
      case BroadcastScope.CLASS:
        return this.studentsInLesson(teacherId, this.requireLessonId(dto));
      case BroadcastScope.ABSENTEES:
        return this.absenteesInLesson(teacherId, this.requireLessonId(dto));
      case BroadcastScope.LOW_GRADES:
        return this.studentsWithLowGrades(teacherId, dto.lessonId);
    }
  }

  private requireLessonId(dto: TeacherBroadcastDto): string {
    if (dto.lessonId === undefined) {
      throw new BadRequestException(
        biBody(
          `lessonId is required for the "${dto.scope}" scope`,
          `معرّف الدرس مطلوب لنطاق "${dto.scope}"`,
        ),
      );
    }
    return dto.lessonId;
  }

  private async assertOwnsLesson(teacherId: string, lessonId: string): Promise<void> {
    const lesson = await this.lessons.findOne({ where: { id: lessonId, deleted_at: IsNull() } });
    if (!lesson) throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody(
          'You can only message students in your own lessons',
          'يمكنك مراسلة الطلاب في دروسك الخاصة فقط',
        ),
      );
    }
  }

  private async studentsInLesson(teacherId: string, lessonId: string): Promise<string[]> {
    await this.assertOwnsLesson(teacherId, lessonId);

    const [direct, viaPackage] = await Promise.all([
      this.lessonPurchases.find({ where: { lesson_id: lessonId } }),
      this.packagePurchases
        .createQueryBuilder('pp')
        .innerJoin('pp.package', 'package')
        .innerJoin('package.items', 'items')
        .where('items.lesson_id = :lessonId', { lessonId })
        .distinct(true)
        .select('pp.student_id', 'student_id')
        .getRawMany<{ student_id: string }>(),
    ]);

    const ids = new Set<string>();
    for (const row of direct) ids.add(row.student_id);
    for (const row of viaPackage) ids.add(row.student_id);
    return [...ids];
  }

  private async absenteesInLesson(teacherId: string, lessonId: string): Promise<string[]> {
    await this.assertOwnsLesson(teacherId, lessonId);
    const rows = await this.attendanceRecords.find({
      where: { lesson_id: lessonId, status: 'absent' },
    });
    return rows.map((r) => r.student_id);
  }

  private async studentsWithLowGrades(teacherId: string, lessonId?: string): Promise<string[]> {
    if (lessonId !== undefined) await this.assertOwnsLesson(teacherId, lessonId);

    const qb = this.examAttempts
      .createQueryBuilder('a')
      .innerJoin('a.exam', 'exam')
      .where('exam.teacher_id = :teacherId', { teacherId })
      .andWhere('a.state = :state', { state: AttemptState.GRADED });

    if (lessonId !== undefined) qb.andWhere('exam.lesson_id = :lessonId', { lessonId });

    const rows = await qb
      .select('a.student_id', 'student_id')
      .addSelect('AVG(a.score_total / NULLIF(a.max_score, 0) * 100)', 'avg_pct')
      .groupBy('a.student_id')
      .having('AVG(a.score_total / NULLIF(a.max_score, 0) * 100) < :threshold', {
        threshold: LOW_SCORE_THRESHOLD,
      })
      .getRawMany<{ student_id: string; avg_pct: string }>();

    return rows.map((r) => r.student_id);
  }
}
