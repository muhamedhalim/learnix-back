import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceCourseCompletedEvent } from '../events/domain.events';

/**
 * FR-242, FR-333. An enrollment is marked complete, with a timestamp, the
 * moment `progress_bps` reaches 10000 — the exact figure
 * `ProgressService.recompute()` just derived, never re-measured here.
 * Permanent once set: reversing a required lesson's completion afterward
 * (FR-238 permits reversal) lowers `progress_bps` again but does not clear
 * `completed_at` — "completing a course" is a one-time milestone (matching
 * FR-248's "issue exactly one certificate"), not a toggle that could revoke
 * an already-issued certificate merely by unchecking a lesson. A course
 * with zero required lessons can never trigger this: `recompute()` always
 * returns 0 for it, which never equals 10000.
 */
@Injectable()
export class CompletionService {
  constructor(
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async checkCompletion(enrollmentId: string, progressBps: number, manager?: EntityManager): Promise<boolean> {
    if (progressBps !== 10000) return false;

    const enrollmentRepo = manager ? manager.getRepository(MarketplaceEnrollment) : this.enrollments;
    const enrollment = await enrollmentRepo.findOneOrFail({ where: { id: enrollmentId } });
    if (enrollment.completed_at !== null) return false;

    const completedAt = new Date();
    await enrollmentRepo.update({ id: enrollmentId }, { completed_at: completedAt });

    this.eventEmitter.emit(
      MarketplaceCourseCompletedEvent.EVENT_NAME,
      new MarketplaceCourseCompletedEvent(enrollment.id, enrollment.course_id, enrollment.learner_id),
    );

    return true;
  }
}
