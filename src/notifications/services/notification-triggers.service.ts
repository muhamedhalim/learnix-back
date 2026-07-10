import { Injectable, Logger } from '@nestjs/common';

import { NotificationType } from '../entities';
import { NotificationsService } from './notifications.service';

/**
 * In-app notification triggers.
 *
 * This service used to own parent messaging too, via `notifyExamGraded`,
 * `notifyPurchaseCompleted`, `notifyLessonExpiring` and `notifyAttendance` —
 * every one of which was dead code with zero callers, and all of which built
 * their message text by string interpolation. Guardian messaging now flows
 * through domain events → BullMQ → the template catalogue, so those methods are
 * gone rather than left to rot.
 *
 * What remains is the one path that genuinely targets a platform *user*.
 */
@Injectable()
export class NotificationTriggersService {
  private readonly logger = new Logger(NotificationTriggersService.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Admin-composed message to a user.
   *
   * In-app only. It previously routed to the recipient's *parent's* phone,
   * because `shouldSendSmsForType` returned `true` unconditionally for
   * `CUSTOM` — so an admin writing to a student silently SMSed the parent.
   */
  public async sendCustomNotification(
    userId: string,
    title: string,
    message: string,
  ): Promise<void> {
    try {
      await this.notificationsService.create(
        {
          user_id: userId,
          type: NotificationType.CUSTOM,
          title,
          message,
          send_sms: false,
        },
        false,
      );

      this.logger.log(`Custom notification sent to user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to send custom notification to user ${userId}:`, error);
    }
  }
}
