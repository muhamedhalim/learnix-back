import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MailService } from '../../mail/mail.service';
import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { NotificationsService } from '../../notifications/services/notifications.service';
import {
  MarketplaceApplicationApprovedEvent,
  MarketplaceApplicationRejectedEvent,
} from '../events/domain.events';
import { InstructorApplication } from '../instructors/entities/instructor-application.entity';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * FR-018/FR-019: the applicant has to learn the outcome. Until now the only message anyone got was the
 * password-setup email of a freshly provisioned account; a signed-in applicant heard nothing, and a
 * rejected applicant heard nothing at all, so a rejection (and its reason) was found only by opening the
 * form again.
 *
 * - A signed-in applicant gets an in-app notification for either decision.
 * - A public applicant who is rejected has no account, so the only channel is the contact email they gave.
 * - An approved public applicant is told by the setup email itself (`InstructorAccountService`), so no
 *   second message is sent for them: a notification to an account that cannot sign in yet would be noise.
 *
 * Delivery problems are logged and never propagate: the decision is already committed.
 */
@Injectable()
export class ApplicationDecisionNotificationListener {
  private readonly logger = new Logger(ApplicationDecisionNotificationListener.name);

  constructor(
    @InjectRepository(InstructorApplication) private readonly applications: Repository<InstructorApplication>,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  @OnEvent(MarketplaceApplicationApprovedEvent.EVENT_NAME)
  public async handleApproved(event: MarketplaceApplicationApprovedEvent): Promise<void> {
    try {
      const application = await this.applications.findOne({ where: { id: event.applicationId } });
      // A public applicant (no account at submission) is told by the account-setup email.
      if (!application || application.applicant_email !== null) return;
      await this.notifications.create(
        {
          user_id: event.applicantUserId,
          type: NotificationType.MARKETPLACE,
          title: 'Your instructor application was approved',
          message: 'You can now create and publish courses from your instructor workspace.',
          data: { application_id: event.applicationId, link: '/instructor/dashboard' },
        },
        false,
      );
    } catch (error) {
      this.logger.error(`Failed to notify the applicant of approval ${event.applicationId}: ${this.describe(error)}`);
    }
  }

  @OnEvent(MarketplaceApplicationRejectedEvent.EVENT_NAME)
  public async handleRejected(event: MarketplaceApplicationRejectedEvent): Promise<void> {
    try {
      if (event.applicantUserId !== null) {
        await this.notifications.create(
          {
            user_id: event.applicantUserId,
            type: NotificationType.MARKETPLACE,
            title: 'Your instructor application was not approved',
            message: `Reason: ${event.reason}. You can edit your application and submit it again once the waiting period allows.`,
            data: { application_id: event.applicationId, link: '/marketplace/teach' },
          },
          false,
        );
        return;
      }

      const application = await this.applications.findOne({ where: { id: event.applicationId } });
      const email = application?.applicant_email?.trim();
      if (!email) return;
      const subject = 'Update on your instructor application';
      const intro = 'Thank you for applying to teach on Learnix. We reviewed your application and could not approve it this time.';
      const reason = `Reason: ${event.reason}`;
      await this.mail.send({
        to: email,
        ...(application?.display_name ? { recipientName: application.display_name } : {}),
        subject,
        text: [intro, '', reason].join('\n'),
        html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1f2937"><h2>${subject}</h2><p>${intro}</p><p>${escapeHtml(reason)}</p></div>`,
      });
    } catch (error) {
      this.logger.error(`Failed to notify the applicant of rejection ${event.applicationId}: ${this.describe(error)}`);
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
