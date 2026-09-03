import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { MarketplaceCourse } from '../catalog/entities';
import { MarketplaceCourseCompletedEvent } from '../events/domain.events';

/**
 * T132, FR-274. "Notify on course completion and on certificate issuance"
 * is two distinct notifications — the certificate half is already covered
 * for free by the existing academic `CertificateNotificationListener`
 * (`CERTIFICATE_ISSUED_EVENT` is subject-agnostic; it re-reads the saved
 * row and never touches `packageId`), since
 * `MarketplaceCertificateIssuanceService` emits that same event. This
 * listener is only the other half: the completion milestone itself, which
 * fires even for a course with certificates disabled.
 */
@Injectable()
export class CourseCompletionNotificationListener {
  private readonly logger = new Logger(CourseCompletionNotificationListener.name);

  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(MarketplaceCourseCompletedEvent.EVENT_NAME)
  public async handleCourseCompleted(event: MarketplaceCourseCompletedEvent): Promise<void> {
    try {
      const course = await this.courses.findOne({ where: { id: event.courseId } });
      if (!course) return;

      await this.notifications.create(
        {
          user_id: event.learnerId,
          type: NotificationType.MARKETPLACE,
          title: 'Course completed! 🎉',
          message: `You've completed "${course.title}". Great work!`,
          data: { course_id: event.courseId, enrollment_id: event.enrollmentId },
        },
        false,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify learner ${event.learnerId} of course completion ${event.enrollmentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
