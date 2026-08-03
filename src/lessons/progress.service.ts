import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import { LessonCompletedEvent as ParentLessonCompletedEvent, PARENT_EVENT_CHANNEL } from '../notifications/events/parent-events';
import { User } from '../users/entities/user.entity';
import type { LessonProgressDto } from './dto/lesson-progress.dto';
import { Lesson } from './entities/lesson.entity';
import { LessonProgress } from './entities/lesson-progress.entity';

/** Emitted the first time a student's lesson crosses into "completed". */
export const LESSON_COMPLETED_EVENT = 'lesson.completed';

export interface LessonCompletedEvent {
  studentId: string;
  lessonId: string;
}

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    @InjectRepository(LessonProgress)
    private readonly progressRepository: Repository<LessonProgress>,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Update or create progress for a student's lesson
   * Uses upsert pattern - creates if not exists, updates if exists
   */
  public async updateProgress(
    studentId: string,
    lessonId: string,
    watchedDuration: number,
    totalDurationOverride?: number,
  ): Promise<LessonProgressDto> {
    // Get the lesson to validate it exists and get its duration
    const lesson = await this.lessonRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (lesson === null) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }

    // Use provided totalDuration or lesson's duration
    const totalDuration = totalDurationOverride ?? lesson.duration ?? watchedDuration;

    if (totalDuration <= 0) {
      throw new BadRequestException(
        biBody('Total duration must be greater than 0', 'يجب أن تكون المدة الإجمالية أكبر من 0'),
      );
    }

    // Validate watchedDuration is reasonable (max 150% of total for replays)
    const maxWatchedDuration = Math.ceil(totalDuration * 1.5);
    if (watchedDuration > maxWatchedDuration) {
      throw new BadRequestException(
        biBody(
          `Watched duration cannot exceed ${String(maxWatchedDuration)} seconds (150% of total duration)`,
          `لا يمكن أن تتجاوز مدة المشاهدة ${String(maxWatchedDuration)} ثانية (150% من المدة الإجمالية)`,
        ),
      );
    }

    // Calculate progress percentage (capped at 100)
    const progressPercent = Math.min(100, Math.round((watchedDuration / totalDuration) * 100));
    const completed = progressPercent >= 100;

    // Check if progress already exists
    let progress = await this.progressRepository.findOne({
      where: { student_id: studentId, lesson_id: lessonId },
    });

    const wasCompleted = progress?.completed ?? false;

    if (progress === null) {
      // Create new progress record
      progress = this.progressRepository.create({
        student_id: studentId,
        lesson_id: lessonId,
        watched_duration: watchedDuration,
        total_duration: totalDuration,
        progress_percent: progressPercent,
        completed,
        last_watched_at: new Date(),
      });
    } else {
      // Update existing progress
      progress.watched_duration = watchedDuration;
      progress.total_duration = totalDuration;
      progress.progress_percent = progressPercent;
      progress.completed = completed;
      progress.last_watched_at = new Date();
    }

    const savedProgress = await this.progressRepository.save(progress);

    this.logger.log(
      `Progress updated for student ${studentId}, lesson ${lessonId}: ${String(progressPercent)}%`,
    );

    // Fire once, only on the transition into completed, so downstream listeners
    // (e.g. certificate issuance) run exactly once per lesson completion.
    if (savedProgress.completed && !wasCompleted) {
      this.eventEmitter.emit(LESSON_COMPLETED_EVENT, {
        studentId,
        lessonId,
      } satisfies LessonCompletedEvent);

      const student = await this.usersRepository.findOne({ where: { id: studentId } });
      if (student) {
        this.eventEmitter.emit(
          PARENT_EVENT_CHANNEL,
          new ParentLessonCompletedEvent(studentId, lessonId, {
            studentName: student.name,
            lessonName: lesson.title,
          }),
        );
      }
    }

    return {
      id: savedProgress.id,
      lessonId: savedProgress.lesson_id,
      lessonTitle: lesson.title,
      watchedDuration: savedProgress.watched_duration,
      totalDuration: savedProgress.total_duration,
      progressPercent: savedProgress.progress_percent,
      completed: savedProgress.completed,
      lastWatchedAt: savedProgress.last_watched_at,
    };
  }

  /**
   * Get progress for a specific lesson
   */
  public async getProgress(studentId: string, lessonId: string): Promise<LessonProgressDto | null> {
    const progress = await this.progressRepository
      .createQueryBuilder('progress')
      .innerJoinAndSelect('progress.lesson', 'lesson')
      .where('progress.student_id = :studentId', { studentId })
      .andWhere('progress.lesson_id = :lessonId', { lessonId })
      .andWhere('lesson.deleted_at IS NULL')
      .getOne();

    if (progress === null) {
      return null;
    }

    return {
      id: progress.id,
      lessonId: progress.lesson_id,
      lessonTitle: progress.lesson.title,
      watchedDuration: progress.watched_duration,
      totalDuration: progress.total_duration,
      progressPercent: progress.progress_percent,
      completed: progress.completed,
      lastWatchedAt: progress.last_watched_at,
    };
  }

  /**
   * Get all progress records for a student
   */
  public async getAllProgress(studentId: string): Promise<LessonProgressDto[]> {
    const progressRecords = await this.progressRepository
      .createQueryBuilder('progress')
      .innerJoinAndSelect('progress.lesson', 'lesson')
      .where('progress.student_id = :studentId', { studentId })
      .andWhere('lesson.deleted_at IS NULL')
      .orderBy('progress.last_watched_at', 'DESC')
      .getMany();

    return progressRecords.map((progress) => ({
      id: progress.id,
      lessonId: progress.lesson_id,
      lessonTitle: progress.lesson.title,
      watchedDuration: progress.watched_duration,
      totalDuration: progress.total_duration,
      progressPercent: progress.progress_percent,
      completed: progress.completed,
      lastWatchedAt: progress.last_watched_at,
    }));
  }

  /**
   * Get completed lessons count for a student
   */
  public async getCompletedCount(studentId: string): Promise<number> {
    return await this.progressRepository.count({
      where: { student_id: studentId, completed: true },
    });
  }

  /**
   * Get overall progress for a student (average of all lessons)
   */
  public async getOverallProgress(studentId: string): Promise<number> {
    const result = await this.progressRepository
      .createQueryBuilder('progress')
      .select('AVG(progress.progress_percent)', 'avgProgress')
      .where('progress.student_id = :studentId', { studentId })
      .getRawOne<{ avgProgress: string | null }>();

    if (result?.avgProgress === null || result?.avgProgress === undefined) {
      return 0;
    }

    return Math.round(Number.parseFloat(result.avgProgress));
  }
}
