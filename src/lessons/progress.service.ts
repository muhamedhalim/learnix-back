import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import type { LessonProgressDto } from './dto/lesson-progress.dto';
import { Lesson } from './entities/lesson.entity';
import { LessonProgress } from './entities/lesson-progress.entity';

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    @InjectRepository(LessonProgress)
    private readonly progressRepository: Repository<LessonProgress>,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
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
      throw new NotFoundException('Lesson not found');
    }

    // Use provided totalDuration or lesson's duration
    const totalDuration =
      totalDurationOverride ?? lesson.duration ?? watchedDuration;

    if (totalDuration <= 0) {
      throw new BadRequestException('Total duration must be greater than 0');
    }

    // Validate watchedDuration is reasonable (max 150% of total for replays)
    const maxWatchedDuration = Math.ceil(totalDuration * 1.5);
    if (watchedDuration > maxWatchedDuration) {
      throw new BadRequestException(
        `Watched duration cannot exceed ${String(maxWatchedDuration)} seconds (150% of total duration)`,
      );
    }

    // Calculate progress percentage (capped at 100)
    const progressPercent = Math.min(
      100,
      Math.round((watchedDuration / totalDuration) * 100),
    );
    const completed = progressPercent >= 100;

    // Check if progress already exists
    let progress = await this.progressRepository.findOne({
      where: { student_id: studentId, lesson_id: lessonId },
    });

    if (progress !== null) {
      // Update existing progress
      progress.watched_duration = watchedDuration;
      progress.total_duration = totalDuration;
      progress.progress_percent = progressPercent;
      progress.completed = completed;
      progress.last_watched_at = new Date();
    } else {
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
    }

    const savedProgress = await this.progressRepository.save(progress);

    this.logger.log(
      `Progress updated for student ${studentId}, lesson ${lessonId}: ${String(progressPercent)}%`,
    );

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
  public async getProgress(
    studentId: string,
    lessonId: string,
  ): Promise<LessonProgressDto | null> {
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

    return Math.round(parseFloat(result.avgProgress));
  }
}
