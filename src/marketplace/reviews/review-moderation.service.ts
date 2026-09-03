import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { biBody } from '../../i18n/error-translator.util';
import { CourseReviewStatus } from '../common/enums';
import { MarketplaceReviewModeratedEvent } from '../events/domain.events';
import { ModerateReviewDto, ReviewModerationAction } from './dto/moderate-review.dto';
import { MarketplaceCourseReview, MarketplaceReviewReport } from './entities';

const POSTGRES_UNIQUE_VIOLATION = '23505';

const ACTION_TO_STATUS: Record<ReviewModerationAction, CourseReviewStatus> = {
  [ReviewModerationAction.APPROVE]: CourseReviewStatus.APPROVED,
  [ReviewModerationAction.HIDE]: CourseReviewStatus.FLAGGED,
  [ReviewModerationAction.REMOVE]: CourseReviewStatus.REJECTED,
};

export interface ReviewModerationQueue {
  data: MarketplaceCourseReview[];
  meta: PaginationMeta;
}

/**
 * FR-260 – FR-262. "Approve / hide / remove" (contracts §4) all resolve to
 * a `status` change, never a hard delete — unlike the academic reviews
 * module's separate `adminDeleteReview()`, nothing in this feature's FRs
 * requires irreversible deletion, and preserving `moderated_by`/
 * `moderation_reason` on a "removed" review keeps the moderation history
 * auditable rather than losing it. `hide` maps to `FLAGGED` (reversible —
 * an admin can `approve` back), `remove` to `REJECTED` (the more severe,
 * still-reversible-in-principle editorial decision). Both are already
 * excluded from every public surface and aggregate exactly like `FLAGGED`
 * always was (FR-262) — the academic system draws the same "any non-APPROVED
 * status is invisible" line.
 */
@Injectable()
export class ReviewModerationService {
  constructor(
    @InjectRepository(MarketplaceCourseReview)
    private readonly reviews: Repository<MarketplaceCourseReview>,
    @InjectRepository(MarketplaceReviewReport)
    private readonly reports: Repository<MarketplaceReviewReport>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** FR-260: accumulates `report_count` only — never itself changes `status`. Idempotent per reporter via `UQ_mp_review_reports_once`. */
  public async report(reporterId: string, reviewId: string, reason: string): Promise<void> {
    const review = await this.reviews.findOne({ where: { id: reviewId } });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }

    const report = this.reports.create({ review_id: reviewId, reporter_id: reporterId, reason });
    try {
      await this.reports.save(report);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        return; // already reported by this user — a silent no-op, not an error
      }
      throw error;
    }
    await this.reviews.increment({ id: reviewId }, 'report_count', 1);
  }

  /** FR-261: "reported and flagged" — every review with at least one report, or already `FLAGGED`, unless a specific status is requested. */
  public async listForModeration(status?: CourseReviewStatus, page = 1, limit = 20): Promise<ReviewModerationQueue> {
    const qb = this.reviews.createQueryBuilder('r').leftJoinAndSelect('r.course', 'course');
    if (status) {
      qb.andWhere('r.status = :status', { status });
    } else {
      qb.andWhere('(r.report_count > 0 OR r.status = :flagged)', { flagged: CourseReviewStatus.FLAGGED });
    }
    qb.orderBy('r.report_count', 'DESC').addOrderBy('r.created_at', 'ASC');
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  public async moderate(adminId: string, reviewId: string, dto: ModerateReviewDto): Promise<MarketplaceCourseReview> {
    if (dto.action !== ReviewModerationAction.APPROVE && !dto.reason?.trim()) {
      throw new BadRequestException(
        biBody('A reason is required to hide or remove a review', 'السبب مطلوب لإخفاء التقييم أو إزالته'),
      );
    }
    const review = await this.reviews.findOne({ where: { id: reviewId } });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }

    review.status = ACTION_TO_STATUS[dto.action];
    review.moderated_by = adminId;
    review.moderation_reason = dto.reason?.trim() ?? null;
    const saved = await this.reviews.save(review);

    this.eventEmitter.emit(
      MarketplaceReviewModeratedEvent.EVENT_NAME,
      new MarketplaceReviewModeratedEvent(saved.id, saved.status),
    );
    return saved;
  }
}
