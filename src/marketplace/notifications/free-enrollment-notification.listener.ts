import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { MarketplaceOrder } from '../commerce/entities';
import { MarketplaceEnrollmentGrantedEvent } from '../events/domain.events';
import { MarketplaceInstructor } from '../instructors/entities/marketplace-instructor.entity';

/**
 * T119, FR-271, FR-275. Reacts only to a **zero-value** grant — a paid
 * purchase's confirmation notification is a separate, not-yet-built task
 * (Phase 9/10), so this deliberately ignores `isZeroValue === false` rather
 * than half-implementing that content here. `NotificationType.MARKETPLACE`
 * (added ahead of this task, FR-267 – FR-277) keeps this fully in-app: the
 * academic guardian/SMS fan-out table (`PARENT_EVENT_BY_TYPE`) has no entry
 * for it, and `sendSms: false` is passed anyway for clarity — a marketplace
 * learner is not necessarily a student with a guardian on file at all.
 */
@Injectable()
export class FreeEnrollmentNotificationListener {
  private readonly logger = new Logger(FreeEnrollmentNotificationListener.name);

  constructor(
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(MarketplaceInstructor)
    private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(MarketplaceEnrollmentGrantedEvent.EVENT_NAME)
  public async handleEnrollmentGranted(event: MarketplaceEnrollmentGrantedEvent): Promise<void> {
    if (!event.isZeroValue) return;

    const order = await this.orders.findOne({ where: { id: event.orderId } });
    if (!order) return;

    try {
      // FR-271: confirms access only — no price, payment method or refund
      // window mentioned, since none of that applies to a free enrollment.
      await this.notifications.create(
        {
          user_id: event.learnerId,
          type: NotificationType.MARKETPLACE,
          title: 'Enrollment confirmed',
          message: `You're enrolled in "${order.course_title_snapshot}". Start learning now.`,
          data: { course_id: event.courseId, enrollment_id: event.enrollmentId, order_id: order.id },
        },
        false,
      );
    } catch (error) {
      this.logger.error(`Failed to notify learner ${event.learnerId} of free enrollment ${event.enrollmentId}`, error);
    }

    const instructor = await this.instructors.findOne({ where: { id: order.instructor_id } });
    if (!instructor) return;

    try {
      // FR-275: distinguishable from a sale — explicitly names it free, and
      // never states an amount, unlike a future paid-purchase notification.
      await this.notifications.create(
        {
          user_id: instructor.user_id,
          type: NotificationType.MARKETPLACE,
          title: 'New free enrollment',
          message: `A learner enrolled for free in "${order.course_title_snapshot}".`,
          data: { course_id: event.courseId, enrollment_id: event.enrollmentId, order_id: order.id, is_free: true },
        },
        false,
      );
    } catch (error) {
      this.logger.error(`Failed to notify instructor ${instructor.user_id} of free enrollment ${event.enrollmentId}`, error);
    }
  }
}
