import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { NotificationsService } from '../../notifications/services/notifications.service';
import {
  MarketplaceEarningClearedEvent,
  MarketplaceEarningReversedEvent,
  MarketplacePayoutApprovedEvent,
  MarketplacePayoutFailedEvent,
  MarketplacePayoutPaidEvent,
  MarketplacePayoutProcessingEvent,
  MarketplacePayoutRejectedEvent,
  MarketplacePayoutRequestedEvent,
} from '../events/domain.events';
import { MarketplaceInstructor } from '../instructors/entities/marketplace-instructor.entity';

/**
 * T183, FR-276, FR-277. Every event here carries `instructorId` as a
 * `MarketplaceInstructor.id` (the capability row's PK, never `users.id`),
 * resolved to `instructor.user_id` before notifying — the same step every
 * other instructor-facing listener in this feature takes.
 */
@Injectable()
export class EarningsPayoutNotificationListener {
  private readonly logger = new Logger(EarningsPayoutNotificationListener.name);

  constructor(
    @InjectRepository(MarketplaceInstructor) private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(MarketplaceEarningClearedEvent.EVENT_NAME)
  public async handleEarningCleared(event: MarketplaceEarningClearedEvent): Promise<void> {
    await this.notify(event.instructorId, 'Earning available', 'An earning has cleared and is now available for payout.', {
      earning_id: event.earningId,
      order_id: event.orderId,
    });
  }

  @OnEvent(MarketplaceEarningReversedEvent.EVENT_NAME)
  public async handleEarningReversed(event: MarketplaceEarningReversedEvent): Promise<void> {
    await this.notify(event.instructorId, 'Earning reversed', 'An earning was reversed following a refund.', {
      earning_id: event.earningId,
      order_id: event.orderId,
    });
  }

  @OnEvent(MarketplacePayoutRequestedEvent.EVENT_NAME)
  public async handlePayoutRequested(event: MarketplacePayoutRequestedEvent): Promise<void> {
    await this.notify(event.instructorId, 'Payout request received', "We've received your payout request and are reviewing it.", {
      payout_request_id: event.payoutRequestId,
    });
  }

  @OnEvent(MarketplacePayoutApprovedEvent.EVENT_NAME)
  public async handlePayoutApproved(event: MarketplacePayoutApprovedEvent): Promise<void> {
    await this.notify(event.instructorId, 'Payout approved', 'Your payout request was approved and will be processed soon.', {
      payout_request_id: event.payoutRequestId,
    });
  }

  @OnEvent(MarketplacePayoutRejectedEvent.EVENT_NAME)
  public async handlePayoutRejected(event: MarketplacePayoutRejectedEvent): Promise<void> {
    await this.notify(event.instructorId, 'Payout rejected', `Your payout request was rejected: ${event.reason}.`, {
      payout_request_id: event.payoutRequestId,
      reason: event.reason,
    });
  }

  @OnEvent(MarketplacePayoutProcessingEvent.EVENT_NAME)
  public async handlePayoutProcessing(event: MarketplacePayoutProcessingEvent): Promise<void> {
    await this.notify(event.instructorId, 'Payout processing', 'Your payout is now being processed.', {
      payout_request_id: event.payoutRequestId,
    });
  }

  @OnEvent(MarketplacePayoutPaidEvent.EVENT_NAME)
  public async handlePayoutPaid(event: MarketplacePayoutPaidEvent): Promise<void> {
    await this.notify(event.instructorId, 'Payout paid', `Your payout has been paid. Reference: ${event.payoutReference}.`, {
      payout_request_id: event.payoutRequestId,
      payout_reference: event.payoutReference,
    });
  }

  @OnEvent(MarketplacePayoutFailedEvent.EVENT_NAME)
  public async handlePayoutFailed(event: MarketplacePayoutFailedEvent): Promise<void> {
    await this.notify(event.instructorId, 'Payout failed', `Your payout could not be completed: ${event.reason}.`, {
      payout_request_id: event.payoutRequestId,
      reason: event.reason,
    });
  }

  private async notify(
    instructorId: string,
    title: string,
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      const instructor = await this.instructors.findOne({ where: { id: instructorId } });
      if (!instructor) return;
      await this.notifications.create(
        { user_id: instructor.user_id, type: NotificationType.MARKETPLACE, title, message, data },
        false,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify instructor ${instructorId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
