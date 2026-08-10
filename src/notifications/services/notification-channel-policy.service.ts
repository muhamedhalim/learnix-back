import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { UpdateNotificationSettingsDto } from '../dto';
import { NotificationChannel, NotificationSettings } from '../entities';

/** Why a channel was allowed or refused, for the delivery record and the log. */
export interface ChannelDecision {
  channel: NotificationChannel;
  allowed: boolean;
  /** Present only when `allowed === false`. */
  reason?: 'preference_disabled';
}

export type ChannelPreferences = Readonly<Record<NotificationChannel, boolean>>;

/**
 * THE channel-policy chokepoint. One question, one answer, one place.
 *
 * Before this existed, `sms_enabled` was consulted in exactly one method of
 * `NotificationsService` and nowhere else, while `email_enabled` and
 * `push_enabled` were consulted by nothing at all — three switches in the UI,
 * one of which worked, on one of the two guardian dispatch paths. That is
 * DEF-005 in one sentence.
 *
 * The rule this service enforces is:
 *
 *     Notification event
 *       → resolve recipient          (the domain decides)
 *       → resolve event eligibility  (guardian links / notification type)
 *       → resolve channel preference (HERE, and only here)
 *       → dispatch channel
 *       → record result              (notification_deliveries)
 *
 * Two properties are load-bearing and must survive future edits:
 *
 *  1. **It owns the settings row.** Reads and writes of `notification_settings`
 *     go through this class, so the value the Settings screen persists and the
 *     value the dispatcher enforces cannot drift apart — they are literally the
 *     same query. `NotificationsService.getOrCreateSettings/updateSettings`
 *     remain as thin delegates for their existing callers.
 *
 *  2. **It is not the transactional-mail gate.** Password resets, login
 *     verification, invoices and operational alerts are not notifications and
 *     must never be routed through here; disabling "Email notifications" must
 *     not be able to lock a user out of their own account recovery. Optional
 *     notification email goes through `NotificationEmailService`, which does
 *     consult this; everything security-critical keeps calling `MailService`
 *     directly. See `NotificationEmailService` for the enumerated boundary.
 *
 * Whose preferences? The USER THE NOTIFICATION CONCERNS — `notification.user_id`
 * for in-app-derived channels, and the STUDENT for the guardian fan-out. The
 * latter preserves the semantics the SMS gate has always had (a student's
 * `sms_enabled` gated SMS to that student's guardians) rather than inventing a
 * new one, and it is what makes "channel off overrides an otherwise eligible
 * event" true.
 */
@Injectable()
export class NotificationChannelPolicyService {
  private readonly logger = new Logger(NotificationChannelPolicyService.name);

  constructor(
    @InjectRepository(NotificationSettings)
    private readonly settingsRepository: Repository<NotificationSettings>,
  ) {}

  /**
   * Read-or-create the canonical settings row.
   *
   * Concurrent first-touch (a page load and a dispatch racing) is resolved by
   * the UNIQUE index on `user_id` rather than by a check-then-insert that both
   * callers would win: the loser reads back the winner's row.
   */
  public async getOrCreateSettings(userId: string): Promise<NotificationSettings> {
    const existing = await this.settingsRepository.findOne({ where: { user_id: userId } });
    if (existing) return existing;

    await this.settingsRepository
      .createQueryBuilder()
      .insert()
      .into(NotificationSettings)
      .values({
        user_id: userId,
        sms_enabled: true,
        email_enabled: false,
        push_enabled: false,
      })
      .orIgnore()
      .execute();

    return await this.settingsRepository.findOneOrFail({ where: { user_id: userId } });
  }

  /**
   * Apply a settings patch.
   *
   * Only the three channel fields are honoured. The DTO still *accepts* the
   * four removed `notify_parent_on_*` names so an older frontend build does not
   * get a 400 from `forbidNonWhitelisted` mid-deploy, but they are inert:
   * guardian event preferences live on the guardian link and are edited through
   * `PUT /student/guardians/:guardianId/preferences`.
   */
  public async updateSettings(
    userId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettings> {
    const settings = await this.getOrCreateSettings(userId);

    if (dto.sms_enabled !== undefined) settings.sms_enabled = dto.sms_enabled;
    if (dto.email_enabled !== undefined) settings.email_enabled = dto.email_enabled;
    if (dto.push_enabled !== undefined) settings.push_enabled = dto.push_enabled;

    return await this.settingsRepository.save(settings);
  }

  /** Every channel preference for one user, in one query. */
  public async resolve(userId: string): Promise<ChannelPreferences> {
    const settings = await this.getOrCreateSettings(userId);
    return Object.freeze({
      [NotificationChannel.SMS]: settings.sms_enabled,
      [NotificationChannel.EMAIL]: settings.email_enabled,
      [NotificationChannel.PUSH]: settings.push_enabled,
    });
  }

  /**
   * The single check every sender must make before touching a provider.
   *
   * Returns a decision rather than a boolean so the caller can record *why*
   * nothing was sent — `skipped_preference` is a legitimate, reportable
   * outcome, not an absence of one.
   */
  public async decide(userId: string, channel: NotificationChannel): Promise<ChannelDecision> {
    const preferences = await this.resolve(userId);
    if (preferences[channel]) return { channel, allowed: true };

    this.logger.debug(`Channel ${channel} suppressed for user ${userId} by preference`);
    return { channel, allowed: false, reason: 'preference_disabled' };
  }

  /** Convenience for callers that only branch on the outcome. */
  public async isAllowed(userId: string, channel: NotificationChannel): Promise<boolean> {
    return (await this.decide(userId, channel)).allowed;
  }
}
