import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { MarketplaceOrder } from '../commerce/entities';
import {
  MarketplaceRefundAwaitingPayoutEvent,
  MarketplaceRefundCompletedEvent,
  MarketplaceRefundFailedEvent,
  MarketplaceRefundRefusedEvent,
  MarketplaceRefundRequestedEvent,
} from '../events/domain.events';
import { MarketplaceInstructor } from '../instructors/entities/marketplace-instructor.entity';

const FAILED_CONDITION_MESSAGES: Record<string, string> = {
  REFUND_WINDOW_EXPIRED: 'the refund window for this order has closed',
  REFUND_CONSUMPTION_EXCEEDED: 'too much of the course has been completed to qualify',
  NOTHING_TO_REFUND: 'there is nothing to refund for this order',
};

/**
 * T147, FR-273. One listener for all four learner-facing refund moments;
 * the discretionary-grant moment has no separate notification of its own —
 * a discretionary grant re-enters normal processing and fires the same
 * `completed`/`failed` event as any other refund. "Admins informed" of a
 * provider failure (FR-194) is the admin refund queue itself
 * (`GET /marketplace/admin/refunds`, already showing `failure_reason`) —
 * matching how every other admin moderation queue in this feature works,
 * rather than a push notification to every admin account.
 */
@Injectable()
export class RefundNotificationListener {
  private readonly logger = new Logger(RefundNotificationListener.name);

  constructor(
    @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(MarketplaceInstructor) private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(MarketplaceRefundRequestedEvent.EVENT_NAME)
  public async handleRequested(event: MarketplaceRefundRequestedEvent): Promise<void> {
    await this.safeNotifyLearner(event.orderId, event.learnerId, async (order) => ({
      title: 'Refund request received',
      message: `We've received your refund request for "${order.course_title_snapshot}" and are reviewing it.`,
      data: { order_id: event.orderId, refund_request_id: event.refundRequestId },
    }));
  }

  @OnEvent(MarketplaceRefundRefusedEvent.EVENT_NAME)
  public async handleRefused(event: MarketplaceRefundRefusedEvent): Promise<void> {
    await this.safeNotifyLearner(event.orderId, undefined, async (order) => ({
      title: 'Refund request refused',
      message: `Your refund request for "${order.course_title_snapshot}" was refused: ${FAILED_CONDITION_MESSAGES[event.failedCondition] ?? event.failedCondition}.`,
      data: {
        order_id: event.orderId,
        refund_request_id: event.refundRequestId,
        failed_condition: event.failedCondition,
      },
    }));
  }

  @OnEvent(MarketplaceRefundCompletedEvent.EVENT_NAME)
  public async handleCompleted(event: MarketplaceRefundCompletedEvent): Promise<void> {
    await this.safeNotifyLearner(event.orderId, event.learnerId, async (order) => ({
      title: event.isRemovalDriven
        ? 'Course removed — you were refunded in full'
        : 'Refund completed',
      message: event.isRemovalDriven
        ? `"${order.course_title_snapshot}" was permanently removed from the marketplace. You've been refunded in full.`
        : `Your refund for "${order.course_title_snapshot}" has been completed.`,
      data: {
        order_id: event.orderId,
        refund_request_id: event.refundRequestId,
        removal_driven: event.isRemovalDriven,
      },
    }));

    try {
      const order = await this.orders.findOne({ where: { id: event.orderId } });
      if (!order) return;
      // `event.instructorId` is `MarketplaceInstructor.id` (the capability
      // row's PK, per `MarketplaceOrder.instructor_id`'s relation target),
      // never a `users.id` — must be resolved to `instructor.user_id`
      // before notifying, the same step `FreeEnrollmentNotificationListener`
      // already takes for exactly this reason.
      const instructor = await this.instructors.findOne({ where: { id: event.instructorId } });
      if (!instructor) return;
      await this.notifications.create(
        {
          user_id: instructor.user_id,
          type: NotificationType.MARKETPLACE,
          title: event.isRemovalDriven
            ? 'Course removal: a sale was reversed'
            : 'A refund was issued',
          message: `"${order.course_title_snapshot}" was refunded to the learner; your earning for this order has been reversed.`,
          data: {
            order_id: event.orderId,
            refund_request_id: event.refundRequestId,
            removal_driven: event.isRemovalDriven,
          },
        },
        false,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify instructor of refund completion for order ${event.orderId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  @OnEvent(MarketplaceRefundAwaitingPayoutEvent.EVENT_NAME)
  public async handleAwaitingPayout(event: MarketplaceRefundAwaitingPayoutEvent): Promise<void> {
    await this.safeNotifyLearner(event.orderId, undefined, async (order) => ({
      title: 'Refund approved',
      message: `Your refund for "${order.course_title_snapshot}" was approved. It is paid back by hand, which can take a few business days; we'll let you know as soon as it has been sent.`,
      data: { order_id: event.orderId, refund_request_id: event.refundRequestId },
    }));
  }

  @OnEvent(MarketplaceRefundFailedEvent.EVENT_NAME)
  public async handleFailed(event: MarketplaceRefundFailedEvent): Promise<void> {
    await this.safeNotifyLearner(event.orderId, undefined, async (order) => ({
      title: 'Refund could not be completed',
      message: `We couldn't process your refund for "${order.course_title_snapshot}" right now. Our team has been notified and will follow up.`,
      data: { order_id: event.orderId, refund_request_id: event.refundRequestId },
    }));
  }

  private async safeNotifyLearner(
    orderId: string,
    knownLearnerId: string | undefined,
    build: (
      order: MarketplaceOrder,
    ) => Promise<{ title: string; message: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    try {
      const order = await this.orders.findOne({ where: { id: orderId } });
      if (!order) return;
      const content = await build(order);
      await this.notifications.create(
        {
          user_id: knownLearnerId ?? order.learner_id,
          type: NotificationType.MARKETPLACE,
          ...content,
        },
        false,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify learner of refund event for order ${orderId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
