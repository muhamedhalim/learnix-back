import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CourseReviewStatus } from '../common/enums';
import { MarketplaceCourseReview } from './entities';

export interface RatingDistribution {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

export interface CourseRatingAggregate {
  averageRating: number;
  reviewCount: number;
  ratingDistribution: RatingDistribution;
}

interface RatingAggregateRow {
  total: string;
  average: string;
  rating_1: string;
  rating_2: string;
  rating_3: string;
  rating_4: string;
  rating_5: string;
}

/**
 * FR-257, FR-258 (T150). Live query-time derivation, the same philosophy
 * `LedgerService.deriveBalance()` and the academic reviews module's own
 * aggregates already use — no cached column exists on `MarketplaceCourse`
 * to keep in sync, so there is nothing to "recompute" beyond the query
 * itself reflecting whatever the review table holds at read time, which it
 * always does. `discovery/course-detail.service.ts` and
 * `discovery/catalog-query.service.ts` already compute the SAME figures
 * inline for the public course-detail/listing surfaces (built ahead of
 * this service, in Phase 5) — this service is not a replacement for those
 * (refactoring already-tested, working queries for a marginal DRY gain was
 * judged not worth the risk) but the canonical aggregate for surfaces that
 * don't yet have one: the instructor's per-course rating (FR-266, T157).
 */
@Injectable()
export class ReviewAggregateService {
  constructor(
    @InjectRepository(MarketplaceCourseReview)
    private readonly reviews: Repository<MarketplaceCourseReview>,
  ) {}

  /** FR-258: no visible reviews → `reviewCount: 0`, an explicit unrated state — never a synthetic non-zero average. */
  public async getCourseAggregate(courseId: string): Promise<CourseRatingAggregate> {
    const row = await this.reviews
      .createQueryBuilder('r')
      .where('r.course_id = :courseId', { courseId })
      .andWhere('r.status = :status', { status: CourseReviewStatus.APPROVED })
      .andWhere('r.withdrawn_at IS NULL')
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(r.rating), 0)', 'average')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 1)', 'rating_1')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 2)', 'rating_2')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 3)', 'rating_3')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 4)', 'rating_4')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 5)', 'rating_5')
      .getRawOne<RatingAggregateRow>();

    return this.toAggregate(row);
  }

  /** Batched N+1-avoidance for the instructor's multi-course review dashboard (FR-266). A course with no approved reviews is simply absent from the returned Map. */
  public async getCourseAggregatesBatch(courseIds: string[]): Promise<Map<string, CourseRatingAggregate>> {
    const result = new Map<string, CourseRatingAggregate>();
    if (courseIds.length === 0) return result;

    const rows = await this.reviews
      .createQueryBuilder('r')
      .where('r.course_id IN (:...courseIds)', { courseIds })
      .andWhere('r.status = :status', { status: CourseReviewStatus.APPROVED })
      .andWhere('r.withdrawn_at IS NULL')
      .select('r.course_id', 'course_id')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(r.rating), 0)', 'average')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 1)', 'rating_1')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 2)', 'rating_2')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 3)', 'rating_3')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 4)', 'rating_4')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 5)', 'rating_5')
      .groupBy('r.course_id')
      .getRawMany<RatingAggregateRow & { course_id: string }>();

    for (const row of rows) {
      result.set(row.course_id, this.toAggregate(row));
    }
    return result;
  }

  private toAggregate(row: RatingAggregateRow | undefined): CourseRatingAggregate {
    if (!row) {
      return { averageRating: 0, reviewCount: 0, ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    }
    return {
      averageRating: Number.parseFloat(row.average),
      reviewCount: Number.parseInt(row.total, 10),
      ratingDistribution: {
        1: Number.parseInt(row.rating_1, 10),
        2: Number.parseInt(row.rating_2, 10),
        3: Number.parseInt(row.rating_3, 10),
        4: Number.parseInt(row.rating_4, 10),
        5: Number.parseInt(row.rating_5, 10),
      },
    };
  }
}
