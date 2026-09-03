import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceEnrollmentStatus } from '../common/enums';
import { MarketplaceEnrollmentRevokedEvent } from '../events/domain.events';
import { MarketplaceEnrollment } from './entities';

/**
 * FR-105, FR-106. Settlement (T098) is the only place an enrollment is
 * *created* — this service only ever manages the lifecycle of one that
 * already exists: revoke, suspend, reinstate. No `expired` state exists
 * and none is introduced here; access is perpetual unless one of these
 * three transitions is explicitly applied, each with a mandatory reason
 * and a recorded timestamp.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async getActiveEnrollment(learnerId: string, courseId: string): Promise<MarketplaceEnrollment | null> {
    return this.enrollments.findOne({
      where: { learner_id: learnerId, course_id: courseId, status: MarketplaceEnrollmentStatus.ACTIVE },
    });
  }

  /** FR-107: "My learning, with progress" needs the course's title/slug/cover to render at all — eager-loaded here since `MarketplaceEnrollment` carries no snapshot of its own. */
  public async listOwnEnrollments(learnerId: string): Promise<MarketplaceEnrollment[]> {
    return this.enrollments.find({ where: { learner_id: learnerId }, relations: ['course'], order: { granted_at: 'DESC' } });
  }

  /** Scoped by `learner_id` so another learner's enrollment id is indistinguishable from a nonexistent one (IDOR). Any status — the caller decides what a non-active row means. */
  public async getOwnEnrollment(learnerId: string, enrollmentId: string): Promise<MarketplaceEnrollment | null> {
    return this.enrollments.findOne({ where: { id: enrollmentId, learner_id: learnerId } });
  }

  /** Refund completion, permanent removal, or an administrative decision — access ends, with a recorded reason. */
  public async revoke(enrollmentId: string, reason: string): Promise<MarketplaceEnrollment> {
    const enrollment = await this.getOrThrow(enrollmentId);
    enrollment.status = MarketplaceEnrollmentStatus.REVOKED;
    enrollment.revoked_at = new Date();
    enrollment.revocation_reason = reason;
    const saved = await this.enrollments.save(enrollment);
    this.eventEmitter.emit(
      MarketplaceEnrollmentRevokedEvent.EVENT_NAME,
      new MarketplaceEnrollmentRevokedEvent(enrollment.id, enrollment.order_id, reason),
    );
    return saved;
  }

  /** A temporary hold (e.g. a policy investigation) — reversible via {@link reinstate}, unlike {@link revoke}. */
  public async suspend(enrollmentId: string, reason: string): Promise<MarketplaceEnrollment> {
    const enrollment = await this.getOrThrow(enrollmentId);
    enrollment.status = MarketplaceEnrollmentStatus.SUSPENDED;
    enrollment.revoked_at = new Date();
    enrollment.revocation_reason = reason;
    return this.enrollments.save(enrollment);
  }

  /** Only ever from `suspended` — a `revoked` enrollment (typically tied to a completed refund) is a terminal state. */
  public async reinstate(enrollmentId: string): Promise<MarketplaceEnrollment> {
    const enrollment = await this.getOrThrow(enrollmentId);
    if (enrollment.status !== MarketplaceEnrollmentStatus.SUSPENDED) {
      throw new NotFoundException(biBody('Only a suspended enrollment can be reinstated', 'يمكن فقط إعادة تفعيل تسجيل موقوف'));
    }
    enrollment.status = MarketplaceEnrollmentStatus.ACTIVE;
    enrollment.revoked_at = null;
    enrollment.revocation_reason = null;
    return this.enrollments.save(enrollment);
  }

  private async getOrThrow(enrollmentId: string): Promise<MarketplaceEnrollment> {
    const enrollment = await this.enrollments.findOne({ where: { id: enrollmentId } });
    if (!enrollment) {
      throw new NotFoundException(biBody('Enrollment not found', 'التسجيل غير موجود'));
    }
    return enrollment;
  }
}
