import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AdminNotificationEvent } from '../../notifications/constants/admin-notification-events';
import { AdminNotificationsService } from '../../notifications/services/admin-notifications.service';
import { MarketplaceCourse } from '../catalog/entities';
import {
  MarketplaceApplicationSubmittedEvent,
  MarketplaceCourseSubmittedEvent,
  MarketplacePayoutRequestedEvent,
  MarketplaceRefundRequestedEvent,
} from '../events/domain.events';
import { MarketplaceInstructor } from '../instructors/entities/marketplace-instructor.entity';

/**
 * T199, FR-268. Turns four marketplace domain events into admin-facing
 * notifications through the platform's existing `AdminNotificationsService`
 * fan-out — the same shared, catalog-governed path the academic side's own
 * `AdminAlertsListener` already uses, not a second admin-notification
 * mechanism. Each event needed a new `AdminNotificationEvent` catalog
 * member (added alongside this listener) since that catalog is a closed
 * allow-list `NotificationsService.findAllForUser` enforces for admin
 * inboxes.
 */
@Injectable()
export class MarketplaceAdminAlertsListener {
  private readonly logger = new Logger(MarketplaceAdminAlertsListener.name);

  constructor(
    @InjectRepository(MarketplaceCourse) private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceInstructor) private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly adminNotifications: AdminNotificationsService,
  ) {}

  @OnEvent(MarketplaceApplicationSubmittedEvent.EVENT_NAME)
  public async handleApplicationSubmitted(event: MarketplaceApplicationSubmittedEvent): Promise<void> {
    await this.safeNotify(() =>
      this.adminNotifications.notifyAdmins(AdminNotificationEvent.MARKETPLACE_APPLICATION_SUBMITTED, {
        title: 'New instructor application',
        message: 'A new professional-instructor application was submitted and is awaiting review.',
        link: `/admin/marketplace/applications/${event.applicationId}`,
        data: { application_id: event.applicationId },
        dedupeKey: event.applicationId,
      }),
    );
  }

  @OnEvent(MarketplaceCourseSubmittedEvent.EVENT_NAME)
  public async handleCourseSubmitted(event: MarketplaceCourseSubmittedEvent): Promise<void> {
    await this.safeNotify(async () => {
      const course = await this.courses.findOne({ where: { id: event.courseId } });
      await this.adminNotifications.notifyAdmins(AdminNotificationEvent.MARKETPLACE_COURSE_SUBMITTED, {
        title: 'Course submitted for review',
        message: course ? `"${course.title}" was submitted for review.` : 'A course was submitted for review.',
        link: `/admin/marketplace/courses/${event.courseId}`,
        data: { course_id: event.courseId },
        dedupeKey: event.courseId,
      });
    });
  }

  @OnEvent(MarketplaceRefundRequestedEvent.EVENT_NAME)
  public async handleRefundRequested(event: MarketplaceRefundRequestedEvent): Promise<void> {
    await this.safeNotify(() =>
      this.adminNotifications.notifyAdmins(AdminNotificationEvent.MARKETPLACE_REFUND_REQUESTED, {
        title: 'Refund requested',
        message: 'A learner requested a marketplace refund.',
        link: `/admin/marketplace/refunds/${event.refundRequestId}`,
        data: { refund_request_id: event.refundRequestId, order_id: event.orderId },
        dedupeKey: event.refundRequestId,
      }),
    );
  }

  @OnEvent(MarketplacePayoutRequestedEvent.EVENT_NAME)
  public async handlePayoutRequested(event: MarketplacePayoutRequestedEvent): Promise<void> {
    await this.safeNotify(async () => {
      const instructor = await this.instructors.findOne({ where: { id: event.instructorId } });
      await this.adminNotifications.notifyAdmins(AdminNotificationEvent.MARKETPLACE_PAYOUT_REQUESTED, {
        title: 'Payout requested',
        message: instructor
          ? `${instructor.display_name} requested a payout.`
          : 'An instructor requested a payout.',
        link: `/admin/marketplace/payouts/${event.payoutRequestId}`,
        data: { payout_request_id: event.payoutRequestId, instructor_id: event.instructorId },
        dedupeKey: event.payoutRequestId,
      });
    });
  }

  private async safeNotify(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(`Failed to notify admins: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
