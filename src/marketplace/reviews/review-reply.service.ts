import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceReviewRepliedEvent } from '../events/domain.events';
import { MarketplaceCourseReview } from './entities';

/**
 * FR-259. `instructor_reply`/`instructor_reply_at` are two columns directly
 * on the review row — the same shape the academic reviews module already
 * uses for `teacher_reply` — so "exactly one reply, editable" needs no
 * uniqueness constraint: a second call simply overwrites the first.
 * "Removable" (T151's addition beyond the academic precedent, which has no
 * delete-reply capability at all) is `deleteReply()`, nulling both columns.
 */
@Injectable()
export class ReviewReplyService {
  constructor(
    @InjectRepository(MarketplaceCourseReview)
    private readonly reviews: Repository<MarketplaceCourseReview>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async reply(instructorId: string, reviewId: string, replyText: string): Promise<MarketplaceCourseReview> {
    const review = await this.getOwnedOrThrow(instructorId, reviewId);
    review.instructor_reply = replyText;
    review.instructor_reply_at = new Date();
    const saved = await this.reviews.save(review);
    this.eventEmitter.emit(MarketplaceReviewRepliedEvent.EVENT_NAME, new MarketplaceReviewRepliedEvent(review.id, review.course_id));
    return saved;
  }

  public async deleteReply(instructorId: string, reviewId: string): Promise<MarketplaceCourseReview> {
    const review = await this.getOwnedOrThrow(instructorId, reviewId);
    review.instructor_reply = null;
    review.instructor_reply_at = null;
    return this.reviews.save(review);
  }

  private async getOwnedOrThrow(instructorId: string, reviewId: string): Promise<MarketplaceCourseReview> {
    const review = await this.reviews.findOne({ where: { id: reviewId }, relations: ['course'] });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
    if (review.course.instructor_id !== instructorId) {
      throw new ForbiddenException(biBody('This review is not on one of your courses', 'هذا التقييم ليس على إحدى دوراتك'));
    }
    return review;
  }
}
