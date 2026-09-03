import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { AccessService } from '../commerce/access.service';
import { MarketplaceEnrollment, MarketplaceLessonProgress } from '../commerce/entities';
import { MarketplaceCourseLesson } from '../catalog/entities';
import { CompletionService } from './completion.service';
import { ProgressService } from './progress.service';

/**
 * FR-238, FR-239. `AccessService.verifyAccess()` gates every call — this
 * service never trusts a caller-supplied enrollment id, only a
 * (learnerId, courseId) pair re-verified live. Mark-complete/incomplete
 * are the *only* way `is_completed` ever changes (FR-238, FR-334 — no
 * client-supplied percentage, timestamp or verdict is ever accepted here);
 * both wrap the progress-row write, `ProgressService.recompute()` and
 * `CompletionService.checkCompletion()` in one retried transaction so the
 * cached `progress_bps`/`completed_at` figures can never drift from the
 * lesson-progress rows that derive them.
 */
@Injectable()
export class LessonProgressService {
  constructor(
    @InjectRepository(MarketplaceLessonProgress)
    private readonly progress: Repository<MarketplaceLessonProgress>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
    private readonly access: AccessService,
    private readonly progressService: ProgressService,
    private readonly completion: CompletionService,
    private readonly dataSource: DataSource,
  ) {}

  /** Idempotent (FR-238): marking an already-complete lesson changes nothing and recomputes nothing. */
  public async markComplete(learnerId: string, courseId: string, lessonId: string): Promise<MarketplaceLessonProgress> {
    const enrollment = await this.access.verifyAccess(learnerId, courseId);
    await this.assertLessonInCourse(lessonId, courseId);

    return retryTransaction(this.dataSource, async (manager) => {
      const repo = manager.getRepository(MarketplaceLessonProgress);
      let row = await repo.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
      if (row?.is_completed) return row;

      row = row ?? repo.create({ enrollment_id: enrollment.id, lesson_id: lessonId });
      row.is_completed = true;
      row.completed_at = new Date();
      row = await repo.save(row);

      const { progressBps } = await this.progressService.recompute(enrollment.id, manager);
      await this.completion.checkCompletion(enrollment.id, progressBps, manager);

      return row;
    });
  }

  /** FR-238's reversal: removes the completion. Never un-completes the enrollment itself (see CompletionService). */
  public async markIncomplete(learnerId: string, courseId: string, lessonId: string): Promise<MarketplaceLessonProgress> {
    const enrollment = await this.access.verifyAccess(learnerId, courseId);
    await this.assertLessonInCourse(lessonId, courseId);

    return retryTransaction(this.dataSource, async (manager) => {
      const repo = manager.getRepository(MarketplaceLessonProgress);
      let row = await repo.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
      if (!row?.is_completed) {
        return row ?? repo.create({ enrollment_id: enrollment.id, lesson_id: lessonId, is_completed: false, completed_at: null, last_position_seconds: 0 });
      }

      row.is_completed = false;
      row.completed_at = null;
      row = await repo.save(row);

      await this.progressService.recompute(enrollment.id, manager);
      return row;
    });
  }

  /** FR-239 — resume position. Never affects progress/completion. */
  public async updatePosition(
    learnerId: string,
    courseId: string,
    lessonId: string,
    positionSeconds: number,
  ): Promise<MarketplaceLessonProgress> {
    const enrollment = await this.access.verifyAccess(learnerId, courseId);
    await this.assertLessonInCourse(lessonId, courseId);

    let row = await this.progress.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
    row = row ?? this.progress.create({ enrollment_id: enrollment.id, lesson_id: lessonId });
    row.last_position_seconds = Math.max(0, Math.trunc(positionSeconds));
    return this.progress.save(row);
  }

  public async listForEnrollment(enrollment: MarketplaceEnrollment, manager?: EntityManager): Promise<MarketplaceLessonProgress[]> {
    const repo = manager ? manager.getRepository(MarketplaceLessonProgress) : this.progress;
    return repo.find({ where: { enrollment_id: enrollment.id } });
  }

  private async assertLessonInCourse(lessonId: string, courseId: string): Promise<void> {
    const lesson = await this.lessons
      .createQueryBuilder('l')
      .innerJoin('l.section', 's')
      .where('l.id = :lessonId', { lessonId })
      .andWhere('s.course_id = :courseId', { courseId })
      .getOne();
    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found in this course', 'الدرس غير موجود في هذه الدورة'));
    }
  }
}
