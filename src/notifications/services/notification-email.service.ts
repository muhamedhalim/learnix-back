import { Injectable, Logger } from '@nestjs/common';

import { MailService, type MailMessage } from '../../mail/mail.service';
import { NotificationChannel, NotificationDeliveryStatus } from '../entities';
import { NotificationChannelPolicyService } from './notification-channel-policy.service';
import { NotificationDeliveryService } from './notification-delivery.service';

export interface NotificationEmailInput extends MailMessage {
  /** Whose `email_enabled` preference governs this send. */
  userId: string;
  /**
   * The in-app notification this email accompanies, when there is one. Supplied
   * so the email leg lands in the same delivery history as the push leg instead
   * of in a separate log nobody reads.
   */
  notificationId?: string;
}

export type NotificationEmailOutcome =
  | 'queued'
  | 'skipped_preference'
  | 'provider_unavailable'
  | 'failed';

/**
 * OPTIONAL notification email, and the `email_enabled` gate.
 *
 * THE BOUNDARY, stated explicitly because getting it wrong locks people out of
 * their own accounts. Mail in this codebase falls into exactly two categories:
 *
 *   **Transactional / security — NEVER gated, and must keep calling
 *   `MailService` directly.** Password reset (`AuthService.requestPasswordReset`),
 *   login verification, invitations, invoices and payment confirmations,
 *   certificate issuance, and operational alerts to administrators
 *   (`OperationalAlertService`). None of these is a "notification the user
 *   opted into"; they are consequences of an action the user just took, or of an
 *   incident an operator must see. A preference screen has no business
 *   suppressing any of them, and this service is not reachable from them.
 *
 *   **Optional notification — gated here.** Mail that merely mirrors an in-app
 *   notification the user could equally read in the app: today, the one-to-one
 *   lesson-session lifecycle mail (confirmed / reminders / link changed /
 *   cancelled) in `LessonSessionsService`. Turning "Email notifications" off
 *   must actually stop these, which is the DEF-005 requirement.
 *
 * Delivery is still asynchronous — `MailService.send` enqueues onto the existing
 * EMAIL queue and `MailProcessor` performs the Amazon SES call — so this adds a
 * preference check and a delivery record, not a second transport.
 */
@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);

  constructor(
    private readonly mail: MailService,
    private readonly policy: NotificationChannelPolicyService,
    private readonly deliveries: NotificationDeliveryService,
  ) {}

  /**
   * Send one optional notification email, subject to `email_enabled`.
   *
   * Never throws: a mail failure must not roll back the domain action that
   * produced the notification, and the in-app record is the durable proof.
   */
  public async send(input: NotificationEmailInput): Promise<NotificationEmailOutcome> {
    const { userId, notificationId, ...message } = input;

    const decision = await this.policy.decide(userId, NotificationChannel.EMAIL);
    if (!decision.allowed) {
      await this.record(notificationId, NotificationDeliveryStatus.SKIPPED_PREFERENCE);
      this.logger.debug(`Notification email suppressed for user ${userId} by preference`);
      return 'skipped_preference';
    }

    if (!this.mail.isConfigured()) {
      await this.record(
        notificationId,
        NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
        undefined,
        { ...message },
      );
      return 'provider_unavailable';
    }

    try {
      if (notificationId === undefined) {
        const queued = await this.mail.send(message);
        return queued ? 'queued' : 'provider_unavailable';
      }
      const claim = await this.deliveries.claim({
        notificationId,
        channel: NotificationChannel.EMAIL,
        provider: this.mail.providerName,
        requestPayload: { ...message },
      });
      if (!claim.claimed) {
        return claim.delivery.status === NotificationDeliveryStatus.SENT
          ? 'queued'
          : 'failed';
      }
      const queued = await this.mail.send({
        ...message,
        notificationDeliveryId: claim.delivery.id,
      });
      if (!queued) {
        await this.deliveries.record(
          claim.delivery.id,
          NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
          { provider: this.mail.providerName },
        );
        return 'provider_unavailable';
      }
      return 'queued';
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Email dispatch failed';
      await this.record(notificationId, NotificationDeliveryStatus.FAILED, reason, { ...message });
      this.logger.warn(`Notification email failed for user ${userId}: ${reason}`);
      return 'failed';
    }
  }

  private async record(
    notificationId: string | undefined,
    status: NotificationDeliveryStatus,
    error?: string,
    requestPayload?: Record<string, unknown>,
  ): Promise<void> {
    if (notificationId === undefined) return;
    const claim = await this.deliveries.claim({
      notificationId,
      channel: NotificationChannel.EMAIL,
      provider: this.mail.providerName,
      requestPayload: requestPayload ?? null,
    });
    if (!claim.claimed) return;
    await this.deliveries.record(claim.delivery.id, status, {
      provider: this.mail.providerName,
      ...(error === undefined ? {} : { error }),
    });
  }
}
