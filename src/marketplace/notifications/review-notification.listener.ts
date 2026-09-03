import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { MarketplaceCourse } from '../catalog/entities';
import { MarketplaceReviewCreatedEvent } from '../events/domain.events';
import { MarketplaceInstructor } from '../instructors/entities/marketplace-instructor.entity';

/**
 * T159, FR-275. `event.instructorId` is a `MarketplaceInstructor.id` (the
 * capability row's PK) — resolved to `instructor.user_id` before
 * notifying, the same step every other instructor-facing listener in this
 * feature takes (`FreeEnrollmentNotificationListener`,
 * `RefundNotificationListener`).
 */
@Injectable()
export class ReviewNotificationListener {
  private readonly logger = new Logger(ReviewNotificationListener.name);

  constructor(
    @InjectRepository(MarketplaceCourse) private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceInstructor) private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(MarketplaceReviewCreatedEvent.EVENT_NAME)
  public async handleReviewCreated(event: MarketplaceReviewCreatedEvent): Promise<void> {
    try {
      const [course, instructor] = await Promise.all([
        this.courses.findOne({ where: { id: event.courseId } }),
        this.instructors.findOne({ where: { id: event.instructorId } }),
      ]);
      if (!course || !instructor) return;

      await this.notifications.create(
        {
          user_id: instructor.user_id,
          type: NotificationType.MARKETPLACE,
          title: 'New review',
          message: `Your course "${course.title}" received a new review.`,
          data: { course_id: event.courseId, review_id: event.reviewId },
        },
        false,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify instructor of new review ${event.reviewId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
