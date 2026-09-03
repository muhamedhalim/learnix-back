import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { Certificate } from '../../certificates/entities/certificate.entity';
import { CertificateStatus } from '../../certificates/entities/certificate-status.enum';
import { biBody } from '../../i18n/error-translator.util';
import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';
import { MarketplaceEnrollment } from '../commerce/entities';
import {
  MarketplaceEnrollmentStatus,
  MarketplaceCourseStatus,
  RefundRequestStatus,
} from '../common/enums';
import { CourseRemovalCause } from '../common/enums';
import { MarketplaceCourseRemovedEvent } from '../events/audit.events';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { MarketplaceRefundRequest } from '../refunds/entities';
import { RefundProcessingService } from '../refunds/refund-processing.service';
import { RefundRequestService } from '../refunds/refund-request.service';
import { MarketplaceCourseReview } from '../reviews/entities/marketplace-course-review.entity';
import { CourseLifecycleService } from './course-lifecycle.service';
import { MarketplaceCourse, MarketplaceCourseRemoval } from './entities';

export interface RemovalOrderJobData {
  removalId: string;
  courseId: string;
  orderId: string;
  enrollmentId: string;
  learnerId: string;
  isZeroValue: boolean;
  totalCount: number;
}

/**
 * FR-054a (T142). `removeCourse()` does the small synchronous part
 * (unpublish, stamp removal, create the summary row) inline; everything
 * per-learner is fanned out as individually queued, individually retryable
 * jobs — not one transaction, since one learner's provider failure must
 * never block or roll back another's successful refund. `processRemovalOrder`
 * is the unit the queue processor calls, and is safe to call directly (unit
 * tests do exactly that) or to re-deliver: every branch re-checks current
 * state before acting, so a retried job never double-refunds, double-revokes,
 * or double-counts the summary row.
 */
@Injectable()
export class CourseRemovalService {
  private readonly logger = new Logger(CourseRemovalService.name);

  constructor(
    @InjectRepository(MarketplaceCourse) private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseRemoval)
    private readonly removals: Repository<MarketplaceCourseRemoval>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    @InjectQueue(QUEUE_NAMES.MARKETPLACE) private readonly marketplaceQueue: Queue,
    private readonly dataSource: DataSource,
    private readonly lifecycle: CourseLifecycleService,
    private readonly refundRequests: RefundRequestService,
    private readonly refundProcessing: RefundProcessingService,
    private readonly activityLogs: ActivityLogsService,
  ) {}

  public async removeCourse(
    adminId: string,
    courseId: string,
    cause: CourseRemovalCause,
    reason: string,
  ): Promise<MarketplaceCourseRemoval> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    if (course.removed_at) {
      // Idempotent: a retried admin action returns the existing record rather than erroring.
      return this.removals.findOneOrFail({ where: { course_id: courseId } });
    }

    if (course.status === MarketplaceCourseStatus.PUBLISHED) {
      await this.lifecycle.adminUnpublish(adminId, courseId, reason);
    } else if (course.status !== MarketplaceCourseStatus.UNPUBLISHED) {
      throw new ConflictException(
        biBody(
          'Only a published or unpublished course can be permanently removed',
          'يمكن فقط إزالة دورة منشورة أو غير منشورة بشكل دائم',
        ),
      );
    }
    // CHK_mp_courses_removed requires status = 'unpublished' whenever removed_at is set — satisfied by the branch above.
    await this.courses.update(courseId, {
      removed_at: new Date(),
      removed_by: adminId,
      removal_reason: reason,
    });

    const targets = await this.enrollments
      .createQueryBuilder('e')
      .innerJoinAndSelect('e.order', 'o')
      .where('e.course_id = :courseId', { courseId })
      .andWhere('e.status IN (:...statuses)', {
        statuses: [MarketplaceEnrollmentStatus.ACTIVE, MarketplaceEnrollmentStatus.SUSPENDED],
      })
      .getMany();

    const removal = await this.removals.save(
      this.removals.create({ course_id: courseId, cause, reason, removed_by: adminId }),
    );

    await this.activityLogs.recordAuditEvent(
      new MarketplaceCourseRemovedEvent(adminId, courseId, {
        courseTitle: course.title,
        cause,
        reason,
      }),
    );

    if (targets.length === 0) {
      await this.removals.update(removal.id, { completed_at: new Date() });
      return this.removals.findOneOrFail({ where: { id: removal.id } });
    }

    await this.marketplaceQueue.addBulk(
      targets.map((enrollment) => ({
        name: JOB_TYPES.MARKETPLACE.REMOVAL_ORDER,
        data: {
          removalId: removal.id,
          courseId,
          orderId: enrollment.order_id,
          enrollmentId: enrollment.id,
          learnerId: enrollment.learner_id,
          isZeroValue: enrollment.order.is_zero_value,
          totalCount: targets.length,
        } satisfies RemovalOrderJobData,
        // Deterministic per order — a re-enqueue (retried admin action, a
        // worker restart replaying its wait list) can never create a second
        // job for the same order.
        opts: { jobId: `marketplace:removal:${enrollment.order_id}` },
      })),
    );

    return removal;
  }

  public async processRemovalOrder(data: RemovalOrderJobData): Promise<void> {
    if (data.isZeroValue) {
      const revoked = await this.revokeZeroValueEnrollment(data.enrollmentId);
      if (revoked) {
        await this.removals.increment({ id: data.removalId }, 'enrollments_revoked', 1);
      }
      return this.maybeComplete(data.removalId, data.totalCount);
    }

    const refundRequestsRepo = this.dataSource.getRepository(MarketplaceRefundRequest);
    const existing = await refundRequestsRepo.findOne({ where: { order_id: data.orderId } });

    if (
      existing &&
      (existing.status === RefundRequestStatus.COMPLETED ||
        existing.status === RefundRequestStatus.FAILED)
    ) {
      // Already counted by a previous delivery of this job — nothing left to do but re-check completion.
      return this.maybeComplete(data.removalId, data.totalCount);
    }

    let result: MarketplaceRefundRequest;
    try {
      result = existing
        ? await this.refundProcessing.process(existing.id)
        : await this.refundRequests.createRemovalDrivenRefund(
            data.orderId,
            data.enrollmentId,
            data.learnerId,
            'Course permanently removed',
          );
    } catch (error) {
      if (error instanceof ConflictException) {
        // A concurrent delivery is already handling this exact order — skip this cycle, BullMQ will not re-run a fulfilled job.
        this.logger.warn(
          `Removal order ${data.orderId} is already being processed concurrently; skipping this delivery.`,
        );
        return;
      }
      throw error;
    }

    if (result.status === RefundRequestStatus.COMPLETED) {
      await this.removals.increment({ id: data.removalId }, 'refunds_issued', 1);
      await this.removals.increment({ id: data.removalId }, 'enrollments_revoked', 1);
      const earning = await this.dataSource
        .getRepository(InstructorEarning)
        .findOne({ where: { order_id: data.orderId } });
      if (earning) {
        await this.removals.increment(
          { id: data.removalId },
          'earnings_reversed_minor',
          Number(earning.net_amount_minor),
        );
        await this.removals.update(data.removalId, { currency: earning.currency });
      }
    } else if (result.status === RefundRequestStatus.FAILED) {
      await this.removals.increment({ id: data.removalId }, 'refunds_failed', 1);
    }

    return this.maybeComplete(data.removalId, data.totalCount);
  }

  /**
   * No earning ever exists for a zero-value order, so there is nothing to
   * reverse there — but a certificate or review can exist regardless of
   * price, and the course is gone for this learner either way. Mirrors the
   * certificate/review half of `RefundProcessingService.completeReversal()`
   * exactly, since "certificates revoked" in T142's AC is not conditioned
   * on payment status.
   */
  private async revokeZeroValueEnrollment(enrollmentId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const enrollment = await manager.findOne(MarketplaceEnrollment, {
        where: { id: enrollmentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!enrollment || enrollment.status === MarketplaceEnrollmentStatus.REVOKED) {
        return false;
      }
      enrollment.status = MarketplaceEnrollmentStatus.REVOKED;
      enrollment.revoked_at = new Date();
      enrollment.revocation_reason = 'Course permanently removed';
      await manager.save(MarketplaceEnrollment, enrollment);

      const certificate = await manager.findOne(Certificate, {
        where: { student_id: enrollment.learner_id, marketplace_course_id: enrollment.course_id },
      });
      if (certificate && certificate.status !== CertificateStatus.REVOKED) {
        certificate.status = CertificateStatus.REVOKED;
        certificate.revoked_at = new Date();
        certificate.revoke_reason = 'Course permanently removed';
        certificate.revocation_context = { source: 'refund' };
        certificate.is_public = false;
        await manager.save(Certificate, certificate);
      }

      const review = await manager.findOne(MarketplaceCourseReview, {
        where: { learner_id: enrollment.learner_id, course_id: enrollment.course_id },
      });
      if (review && !review.withdrawn_at) {
        review.withdrawn_at = new Date();
        await manager.save(MarketplaceCourseReview, review);
      }

      return true;
    });
  }

  private async maybeComplete(removalId: string, totalCount: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const removal = await manager.findOne(MarketplaceCourseRemoval, {
        where: { id: removalId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!removal || removal.completed_at) return;
      const processed = removal.enrollments_revoked + removal.refunds_failed;
      if (processed >= totalCount) {
        removal.completed_at = new Date();
        await manager.save(MarketplaceCourseRemoval, removal);
      }
    });
  }
}
