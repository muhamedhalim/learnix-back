import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceCourseLesson } from '../catalog/entities';

export interface ProgressResult {
  progressBps: number;
  completedRequired: number;
  totalRequired: number;
}

/**
 * FR-240 – FR-243, FR-333, FR-334. The single definition of marketplace
 * course progress: `floor(completed_required × 10000 ÷ total_required)`,
 * counting only lessons with `is_required_for_completion = true`. Lesson
 * duration never enters this. Both counts are always queried live against
 * the course's *current* lesson set (never a version snapshot, never a
 * cached total) — which is what makes T124's requirement free: a curriculum
 * change is reflected the very next time `recompute()` runs, with no
 * separate "handle a curriculum edit" code path needed, and progress on
 * every lesson that still exists is untouched (its `MarketplaceLessonProgress`
 * row is never written by this service). A course with zero required
 * lessons always recomputes to 0 and can never reach 10000 (FR-333) —
 * `CompletionService` never needs its own zero-lesson special case.
 *
 * `progress_bps` on `MarketplaceEnrollment` is a cache; this is its only
 * writer, and every consumer (player, refund eligibility, certificate
 * eligibility) is expected to call `recompute()` rather than read the
 * column directly, so the same figure (FR-241) is always fresh.
 */
@Injectable()
export class ProgressService {
  constructor(
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
  ) {}

  public async recompute(enrollmentId: string, manager?: EntityManager): Promise<ProgressResult> {
    const enrollmentRepo = manager ? manager.getRepository(MarketplaceEnrollment) : this.enrollments;
    const lessonRepo = manager ? manager.getRepository(MarketplaceCourseLesson) : this.lessons;

    const enrollment = await enrollmentRepo.findOneOrFail({ where: { id: enrollmentId } });

    const { total } = (await lessonRepo
      .createQueryBuilder('l')
      .innerJoin('l.section', 's')
      .select('COUNT(*)', 'total')
      .where('s.course_id = :courseId', { courseId: enrollment.course_id })
      .andWhere('l.is_required_for_completion = true')
      .getRawOne<{ total: string }>()) ?? { total: '0' };
    const totalRequired = Number.parseInt(total, 10);

    const { completed } = (await lessonRepo
      .createQueryBuilder('l')
      .innerJoin('l.section', 's')
      .innerJoin('marketplace_lesson_progress', 'p', 'p.lesson_id = l.id AND p.enrollment_id = :enrollmentId', {
        enrollmentId,
      })
      .select('COUNT(*)', 'completed')
      .where('s.course_id = :courseId', { courseId: enrollment.course_id })
      .andWhere('l.is_required_for_completion = true')
      .andWhere('p.is_completed = true')
      .getRawOne<{ completed: string }>()) ?? { completed: '0' };
    const completedRequired = Number.parseInt(completed, 10);

    const progressBps = totalRequired === 0 ? 0 : Math.floor((completedRequired * 10000) / totalRequired);

    await enrollmentRepo.update({ id: enrollmentId }, { progress_bps: progressBps });

    return { progressBps, completedRequired, totalRequired };
  }
}
