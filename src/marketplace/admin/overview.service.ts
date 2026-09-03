import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  CourseReviewStatus,
  InstructorApplicationStatus,
  MarketplaceCourseStatus,
  PayoutRequestStatus,
  RefundRequestStatus,
} from '../common/enums';
import { MarketplaceCourse } from '../catalog/entities';
import { InstructorApplication } from '../instructors/entities';
import { MarketplacePayoutRequest } from '../payouts/entities';
import { MarketplaceRefundRequest } from '../refunds/entities';
import { MarketplaceCourseReview } from '../reviews/entities';

export interface QueueCount {
  count: number;
  oldestWaitingSince: string | null;
}

export interface AdminOverview {
  applications: QueueCount;
  courses: QueueCount;
  reportedReviews: QueueCount;
  refunds: QueueCount;
  payouts: QueueCount;
}

const OPEN_REFUND_STATUSES = [RefundRequestStatus.REQUESTED, RefundRequestStatus.FAILED];
const OPEN_PAYOUT_STATUSES = [PayoutRequestStatus.REQUESTED, PayoutRequestStatus.APPROVED, PayoutRequestStatus.PROCESSING];
const OPEN_APPLICATION_STATUSES = [InstructorApplicationStatus.SUBMITTED, InstructorApplicationStatus.UNDER_REVIEW];

/**
 * FR-286 (T188). Five operational queues, each with a count and the oldest
 * waiting time in it — the console's own "what needs me right now" summary.
 *
 * **Design decisions, not explicitly pinned by the FR text**:
 * - Refunds "awaiting action" is `requested ∪ failed`, not every non-terminal
 *   status — `RefundRequestService.requestRefund()` (T135) auto-decides
 *   synchronously, so a request essentially never *rests* at `requested` in
 *   practice; `failed` is the one state that genuinely needs a human (a
 *   retry). `rejected` is excluded — a discretionary override is an
 *   available admin capability, not something sitting in a queue demanding
 *   attention.
 * - Payouts "awaiting action" is `requested ∪ approved ∪ processing` — every
 *   non-terminal state, since each one is a distinct manual admin step
 *   (approve → processing → paid) with no auto-progression between them.
 * - "Reported reviews" reuses `ReviewModerationService.listForModeration()`'s
 *   own default-queue definition (`report_count > 0 OR status = flagged`)
 *   verbatim rather than a second, possibly-drifting definition.
 */
@Injectable()
export class MarketplaceOverviewService {
  constructor(
    @InjectRepository(InstructorApplication) private readonly applications: Repository<InstructorApplication>,
    @InjectRepository(MarketplaceCourse) private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseReview) private readonly reviews: Repository<MarketplaceCourseReview>,
    @InjectRepository(MarketplaceRefundRequest) private readonly refunds: Repository<MarketplaceRefundRequest>,
    @InjectRepository(MarketplacePayoutRequest) private readonly payouts: Repository<MarketplacePayoutRequest>,
  ) {}

  public async getOverview(): Promise<AdminOverview> {
    const [applications, courses, reportedReviews, refunds, payouts] = await Promise.all([
      this.applicationsQueue(),
      this.coursesQueue(),
      this.reportedReviewsQueue(),
      this.refundsQueue(),
      this.payoutsQueue(),
    ]);
    return { applications, courses, reportedReviews, refunds, payouts };
  }

  private async applicationsQueue(): Promise<QueueCount> {
    const [count, oldest] = await Promise.all([
      this.applications.count({ where: { status: In(OPEN_APPLICATION_STATUSES) } }),
      this.applications.findOne({
        where: { status: In(OPEN_APPLICATION_STATUSES) },
        order: { submitted_at: 'ASC' },
      }),
    ]);
    return { count, oldestWaitingSince: oldest?.submitted_at?.toISOString() ?? null };
  }

  private async coursesQueue(): Promise<QueueCount> {
    const where = { status: MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW };
    const [count, oldest] = await Promise.all([
      this.courses.count({ where }),
      this.courses.findOne({ where, order: { updated_at: 'ASC' } }),
    ]);
    return { count, oldestWaitingSince: oldest?.updated_at?.toISOString() ?? null };
  }

  private async reportedReviewsQueue(): Promise<QueueCount> {
    const qb = () =>
      this.reviews
        .createQueryBuilder('r')
        .where('(r.report_count > 0 OR r.status = :flagged)', { flagged: CourseReviewStatus.FLAGGED });
    const count = await qb().getCount();
    const oldest = await qb().orderBy('r.created_at', 'ASC').getOne();
    return { count, oldestWaitingSince: oldest?.created_at?.toISOString() ?? null };
  }

  private async refundsQueue(): Promise<QueueCount> {
    const where = { status: In(OPEN_REFUND_STATUSES) };
    const [count, oldest] = await Promise.all([
      this.refunds.count({ where }),
      this.refunds.findOne({ where, order: { created_at: 'ASC' } }),
    ]);
    return { count, oldestWaitingSince: oldest?.created_at?.toISOString() ?? null };
  }

  private async payoutsQueue(): Promise<QueueCount> {
    const where = { status: In(OPEN_PAYOUT_STATUSES) };
    const [count, oldest] = await Promise.all([
      this.payouts.count({ where }),
      this.payouts.findOne({ where, order: { requested_at: 'ASC' } }),
    ]);
    return { count, oldestWaitingSince: oldest?.requested_at?.toISOString() ?? null };
  }
}
