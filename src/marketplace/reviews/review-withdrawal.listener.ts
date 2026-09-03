import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceEnrollmentRevokedEvent } from '../events/domain.events';
import { MarketplaceReviewService } from './review.service';

/**
 * FR-263. `RefundProcessingService.completeReversal()` and
 * `CourseRemovalService.revokeZeroValueEnrollment()` already write
 * `withdrawn_at` directly on their own transaction for the refund/removal
 * cases (T136, T142). `EnrollmentService.revoke()` is also the
 * general-purpose revocation method other callers can use — e.g. an admin
 * revoking access for cause outside either of those flows — and *every*
 * call emits this event regardless of reason, so this listener is the
 * catch-all for those other cases. `withdrawForEnrollment()` is idempotent
 * (checked by `withdrawn_at` already being set), so this never conflicts
 * with the two paths that already handle it inline — the same pattern
 * `MarketplaceCertificateIssuanceService.handleEnrollmentRevoked` already
 * establishes for certificates on this exact event.
 */
@Injectable()
export class ReviewWithdrawalListener {
  private readonly logger = new Logger(ReviewWithdrawalListener.name);

  constructor(
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    private readonly reviews: MarketplaceReviewService,
  ) {}

  @OnEvent(MarketplaceEnrollmentRevokedEvent.EVENT_NAME)
  public async handleEnrollmentRevoked(event: MarketplaceEnrollmentRevokedEvent): Promise<void> {
    try {
      const enrollment = await this.enrollments.findOne({ where: { id: event.enrollmentId } });
      if (!enrollment) return;
      await this.reviews.withdrawForEnrollment(enrollment.course_id, enrollment.learner_id);
    } catch (error) {
      this.logger.error(
        `Review withdrawal failed for enrollment ${event.enrollmentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
