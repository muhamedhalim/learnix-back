import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { MarketplaceCourse } from '../catalog/entities';
import { CourseReviewStatus, MarketplaceCourseStatus, MarketplaceEnrollmentStatus } from '../common/enums';
import { reviewAlreadyExists } from '../common/errors';
import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceReviewCreatedEvent } from '../events/domain.events';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewSort } from './dto/review-filter.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { MarketplaceCourseReview } from './entities';

const POSTGRES_UNIQUE_VIOLATION = '23505';

export interface PublicReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  instructor_reply: string | null;
  instructor_reply_at: Date | null;
  created_at: Date;
  learner: { id: string; name: string };
}

export interface PublicReviewList {
  data: PublicReviewRow[];
  meta: PaginationMeta;
}

/**
 * FR-253 – FR-258, FR-264. Owns the learner-authored half of a review's
 * lifecycle (create/edit/delete/list) plus the public read surface — reply
 * (T151) and moderation (T152) are separate services since they act on the
 * same rows from a different actor's authority, not this one's.
 */
@Injectable()
export class MarketplaceReviewService {
  constructor(
    @InjectRepository(MarketplaceCourseReview)
    private readonly reviews: Repository<MarketplaceCourseReview>,
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * FR-253. Checks the active-enrollment gate directly against the
   * `MarketplaceEnrollment` repository rather than injecting
   * `AccessService` — `AccessService` lives in `CommerceModule`, which
   * (via `DiscoveryModule`) already imports `ReviewsModule` for the review
   * repository; importing `CommerceModule` back here would close a real
   * cycle. `MarketplaceEnrollment` is re-registered directly in this
   * module's own `TypeOrmModule.forFeature`, the same "entity registered
   * in more than one module" pattern `InstructorsModule` already uses for
   * `MarketplaceCourse`/`MarketplaceCourseReview`/`MarketplaceEnrollment`.
   * The check itself mirrors `AccessService.verifyAccess()`'s exact logic
   * and exception.
   */
  public async createReview(learnerId: string, dto: CreateReviewDto): Promise<MarketplaceCourseReview> {
    const enrollment = await this.enrollments.findOne({
      where: { learner_id: learnerId, course_id: dto.courseId, status: MarketplaceEnrollmentStatus.ACTIVE },
    });
    if (!enrollment) {
      throw new ForbiddenException(biBody('You do not have access to this course', 'ليس لديك حق الوصول إلى هذه الدورة'));
    }
    const course = await this.courses.findOne({ where: { id: dto.courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }

    let review = this.reviews.create({
      course_id: dto.courseId,
      enrollment_id: enrollment.id,
      learner_id: learnerId,
      rating: dto.rating,
      comment: dto.comment ?? null,
    });
    try {
      review = await this.reviews.save(review);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        throw reviewAlreadyExists();
      }
      throw error;
    }

    this.eventEmitter.emit(
      MarketplaceReviewCreatedEvent.EVENT_NAME,
      new MarketplaceReviewCreatedEvent(review.id, dto.courseId, course.instructor_id),
    );
    return review;
  }

  /** FR-255. */
  public async updateOwnReview(learnerId: string, reviewId: string, dto: UpdateReviewDto): Promise<MarketplaceCourseReview> {
    const review = await this.getOwnOrThrow(learnerId, reviewId);
    if (dto.rating !== undefined) review.rating = dto.rating;
    if (dto.comment !== undefined) review.comment = dto.comment;
    return this.reviews.save(review);
  }

  /** FR-255. Hard delete, mirroring the academic reviews module's own author-delete precedent exactly. */
  public async deleteOwnReview(learnerId: string, reviewId: string): Promise<void> {
    const review = await this.getOwnOrThrow(learnerId, reviewId);
    await this.reviews.remove(review);
  }

  public async getOwnReview(learnerId: string, reviewId: string): Promise<MarketplaceCourseReview> {
    return this.getOwnOrThrow(learnerId, reviewId);
  }

  public async listOwnReviews(learnerId: string): Promise<MarketplaceCourseReview[]> {
    return this.reviews.find({ where: { learner_id: learnerId }, order: { created_at: 'DESC' } });
  }

  /** FR-266: every review across every course this instructor owns, regardless of moderation status — the instructor should see reported/hidden reviews on their own courses too, not only the public-visible subset. */
  public async listForInstructor(instructorId: string): Promise<MarketplaceCourseReview[]> {
    return this.reviews
      .createQueryBuilder('r')
      .innerJoin('r.course', 'course')
      .innerJoin('r.learner', 'learner')
      .addSelect(['course.id', 'course.title', 'learner.id', 'learner.name'])
      .where('course.instructor_id = :instructorId', { instructorId })
      .orderBy('r.created_at', 'DESC')
      .getMany();
  }

  /** FR-264. Only ever `approved` and not withdrawn — the same two conditions the aggregate queries in `discovery/` apply. */
  public async listPublicReviews(slug: string, page: number, limit: number, sort: ReviewSort = 'recent'): Promise<PublicReviewList> {
    const course = await this.courses.findOne({
      where: { slug, status: MarketplaceCourseStatus.PUBLISHED, removed_at: IsNull() },
    });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }

    const qb = this.reviews
      .createQueryBuilder('r')
      .innerJoin('r.learner', 'learner')
      .addSelect(['learner.id', 'learner.name'])
      .where('r.course_id = :courseId', { courseId: course.id })
      .andWhere('r.status = :status', { status: CourseReviewStatus.APPROVED })
      .andWhere('r.withdrawn_at IS NULL')
      .skip((page - 1) * limit)
      .take(limit);

    if (sort === 'rating') {
      qb.orderBy('r.rating', 'DESC').addOrderBy('r.created_at', 'DESC');
    } else {
      qb.orderBy('r.created_at', 'DESC');
    }

    const [rows, total] = await qb.getManyAndCount();
    const data: PublicReviewRow[] = rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      instructor_reply: row.instructor_reply,
      instructor_reply_at: row.instructor_reply_at,
      created_at: row.created_at,
      learner: { id: row.learner.id, name: row.learner.name },
    }));

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

  /**
   * FR-263. Idempotent — safe to call from both the transactional refund
   * paths (which already write `withdrawn_at` directly on their own
   * manager) and the general `MarketplaceEnrollmentRevokedEvent` listener
   * for a non-refund/removal revocation.
   */
  public async withdrawForEnrollment(courseId: string, learnerId: string): Promise<void> {
    const review = await this.reviews.findOne({ where: { course_id: courseId, learner_id: learnerId } });
    if (!review || review.withdrawn_at) return;
    review.withdrawn_at = new Date();
    await this.reviews.save(review);
  }

  private async getOwnOrThrow(learnerId: string, reviewId: string): Promise<MarketplaceCourseReview> {
    const review = await this.reviews.findOne({ where: { id: reviewId, learner_id: learnerId } });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
    return review;
  }
}
