import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { maskPhone } from '../../common/utils/mask.util';
import { GuardiansService } from '../../guardians/guardians.service';
import { biBody } from '../../i18n/error-translator.util';
import { NotificationFilterDto, SendNotificationDto, UpdateNotificationSettingsDto } from '../dto';
import {
  Notification,
  NotificationSettings,
  NotificationStatus,
  NotificationType,
} from '../entities';
import { SmsSenderService } from './sms-sender.service';

export interface PaginatedNotifications {
  data: Notification[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    @InjectRepository(NotificationSettings)
    private readonly settingsRepository: Repository<NotificationSettings>,
    private readonly guardiansService: GuardiansService,
    private readonly smsSenderService: SmsSenderService,
  ) {}

  /**
   * Which in-app notification types are also worth telling a parent about.
   *
   * `CUSTOM` and `GAMIFICATION` map to nothing on purpose. `CUSTOM` previously
   * returned `true` unconditionally, which meant an admin composing a message
   * "to a student" actually SMSed that student's parent, with no hint in the
   * UI. Those stay in-app only.
   */
  private static readonly PARENT_EVENT_BY_TYPE: Readonly<
    Partial<Record<NotificationType, ParentEventType>>
  > = Object.freeze({
    [NotificationType.ATTENDANCE]: ParentEventType.ATTENDANCE_MARKED,
    [NotificationType.EXAM_RESULT]: ParentEventType.EXAM_GRADED,
    [NotificationType.PURCHASE]: ParentEventType.COURSE_PURCHASED,
  });

  /**
   * Create and send a notification
   */
  public async create(dto: SendNotificationDto, sendSms = true): Promise<Notification> {
    const now = new Date();

    // Create notification record
    const notification = this.notificationsRepository.create({
      user_id: dto.user_id,
      type: dto.type,
      title: dto.title,
      message: dto.message,
      data: dto.data ?? null,
      is_read: false,
      sent_at: now,
      sms_sent: false,
      sms_to: null,
      status: NotificationStatus.PENDING,
      attempts: 0,
      error_message: null,
      delivered_at: null,
    });

    const saved = await this.notificationsRepository.save(notification);

    // Fan out to guardians if requested.
    if (sendSms && dto.send_sms !== false) {
      await this.dispatchToGuardians(saved);
    }

    return saved;
  }

  /**
   * Get a notification by ID
   */
  public async findOne(notificationId: string): Promise<Notification> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId },
      relations: ['user'],
    });

    if (!notification) {
      throw new NotFoundException(
        biBody(
          `Notification with ID ${notificationId} not found`,
          `الإشعار ذو المعرف ${notificationId} غير موجود`,
        ),
      );
    }

    return notification;
  }

  /**
   * Get notification details with user info (admin view)
   */
  public async getNotificationDetails(notificationId: string): Promise<{
    id: string;
    type: NotificationType;
    title: string;
    message: string;
    data: Record<string, unknown> | null;
    status: NotificationStatus;
    attempts: number;
    error_message: string | null;
    sms_sent: boolean;
    sms_to: string | null;
    sent_at: Date;
    delivered_at: Date | null;
    read_at: Date | null;
    user: {
      id: string;
      name: string;
      email: string;
    };
  }> {
    const notification = await this.findOne(notificationId);

    return {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      status: notification.status,
      attempts: notification.attempts,
      error_message: notification.error_message,
      sms_sent: notification.sms_sent,
      sms_to: notification.sms_to,
      sent_at: notification.sent_at,
      delivered_at: notification.delivered_at,
      read_at: notification.read_at,
      user: {
        id: notification.user.id,
        name: notification.user.name,
        email: notification.user.email,
      },
    };
  }

  /**
   * Retry a failed notification
   * Only works for notifications with status=FAILED
   */
  public async retryNotification(notificationId: string): Promise<Notification> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new NotFoundException(
        biBody(
          `Notification with ID ${notificationId} not found`,
          `الإشعار ذو المعرف ${notificationId} غير موجود`,
        ),
      );
    }

    if (notification.status !== NotificationStatus.FAILED) {
      throw new BadRequestException(
        biBody(
          `Cannot retry notification with status '${notification.status}'. Only failed notifications can be retried.`,
          `لا يمكن إعادة محاولة إشعار بحالة '${notification.status}'. يمكن فقط إعادة محاولة الإشعارات الفاشلة.`,
        ),
      );
    }

    // Increment attempts and reset status to pending
    notification.attempts += 1;
    notification.status = NotificationStatus.PENDING;
    notification.error_message = null;
    notification.sent_at = new Date();

    await this.notificationsRepository.save(notification);

    // Attempt to resend SMS
    await this.dispatchToGuardians(notification);

    // Reload and return updated notification
    const updated = await this.notificationsRepository.findOne({
      where: { id: notificationId },
    });

    return updated ?? notification;
  }

  /**
   * Fan a notification out to the student's eligible guardians.
   *
   * Recipient resolution is delegated wholesale to `GuardiansService`, which
   * only ever returns guardians linked to *this* student, whose phone is
   * VERIFIED, who have not opted out, and who want this event. There is no way
   * to address an arbitrary number from here.
   *
   * Status semantics (corrected): a successful provider call means the message
   * was **accepted**, not delivered. We record SENT. Only a provider delivery
   * webhook may promote a row to DELIVERED — the previous code stamped
   * `delivered_at` on acceptance, which made the delivery metric read ~100%
   * even when every message silently failed.
   */
  private async dispatchToGuardians(notification: Notification): Promise<void> {
    const attempts = notification.attempts + 1;

    const parentEvent = NotificationsService.PARENT_EVENT_BY_TYPE[notification.type];
    if (parentEvent === undefined) {
      // In-app only (custom/gamification/lesson-expiring). Nothing to send.
      await this.notificationsRepository.update(notification.id, {
        status: NotificationStatus.SENT,
        attempts,
      });
      return;
    }

    const settings = await this.getOrCreateSettings(notification.user_id);
    if (!settings.sms_enabled) {
      await this.notificationsRepository.update(notification.id, {
        status: NotificationStatus.SENT,
        attempts,
      });
      return;
    }

    const targets = await this.guardiansService.findNotificationTargets(
      notification.user_id,
      parentEvent,
    );

    if (targets.length === 0) {
      // Distinct from "sent": nobody was reachable. Recorded as FAILED with a
      // reason so the admin surface can tell "no verified guardian" apart from
      // "delivered". The old code marked this SENT, hiding the gap entirely.
      await this.notificationsRepository.update(notification.id, {
        status: NotificationStatus.FAILED,
        attempts,
        error_message: 'No verified guardian for this student',
      });
      this.logger.warn(`No verified guardian for user ${notification.user_id}`);
      return;
    }

    const results = await this.smsSenderService.sendBulkSms(
      targets.map((target) => ({ phone: target.phone_e164, message: notification.message })),
    );

    const accepted = results.filter((result) => result.success).length;
    const firstTarget = targets[0];

    if (accepted > 0) {
      await this.notificationsRepository.update(notification.id, {
        sms_sent: true,
        sms_to: firstTarget?.phone_e164 ?? null,
        status: NotificationStatus.SENT,
        attempts,
        error_message: null,
      });
      this.logger.log(
        `Notification ${notification.id} accepted by provider for ` +
          `${String(accepted)}/${String(targets.length)} guardian(s)`,
      );
      return;
    }

    const reason = results.find((result) => !result.success)?.error ?? 'SMS delivery failed';
    await this.notificationsRepository.update(notification.id, {
      sms_to: firstTarget?.phone_e164 ?? null,
      status: NotificationStatus.FAILED,
      attempts,
      error_message: reason,
    });
    this.logger.warn(
      `Notification ${notification.id} failed for all ${String(targets.length)} guardian(s) ` +
        `(first: ${maskPhone(firstTarget?.phone_e164) ?? '***'}): ${reason}`,
    );
  }

  /**
   * Get paginated notifications for a user
   */
  public async findAllForUser(
    userId: string,
    filter: NotificationFilterDto,
  ): Promise<PaginatedNotifications> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.notificationsRepository
      .createQueryBuilder('notification')
      .where('notification.user_id = :userId', { userId });

    // Apply filters
    if (filter.type !== undefined) {
      queryBuilder.andWhere('notification.type = :type', { type: filter.type });
    }

    if (filter.is_read !== undefined) {
      queryBuilder.andWhere('notification.is_read = :isRead', {
        isRead: filter.is_read,
      });
    }

    if (filter.sms_sent !== undefined) {
      queryBuilder.andWhere('notification.sms_sent = :smsSent', {
        smsSent: filter.sms_sent,
      });
    }

    if (filter.sent_after !== undefined) {
      queryBuilder.andWhere('notification.sent_at >= :sentAfter', {
        sentAfter: new Date(filter.sent_after),
      });
    }

    if (filter.sent_before !== undefined) {
      queryBuilder.andWhere('notification.sent_at <= :sentBefore', {
        sentBefore: new Date(filter.sent_before),
      });
    }

    // Order by most recent first
    queryBuilder.orderBy('notification.sent_at', 'DESC');

    // Get total count and paginated results
    const [data, total] = await queryBuilder.skip(skip).take(limit).getManyAndCount();

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Get unread notification count for a user
   */
  public async getUnreadCount(userId: string): Promise<number> {
    return await this.notificationsRepository.count({
      where: { user_id: userId, is_read: false },
    });
  }

  /**
   * Mark a notification as read
   */
  public async markAsRead(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId, user_id: userId },
    });

    if (!notification) {
      throw new NotFoundException(biBody('Notification not found', 'الإشعار غير موجود'));
    }

    if (!notification.is_read) {
      notification.is_read = true;
      notification.read_at = new Date();
      return await this.notificationsRepository.save(notification);
    }

    return notification;
  }

  /**
   * Mark all notifications as read for a user
   */
  public async markAllAsRead(userId: string): Promise<{ count: number }> {
    const result = await this.notificationsRepository.update(
      { user_id: userId, is_read: false },
      { is_read: true, read_at: new Date() },
    );

    return { count: result.affected ?? 0 };
  }

  /**
   * Get or create notification settings for a user
   */
  public async getOrCreateSettings(userId: string): Promise<NotificationSettings> {
    let settings = await this.settingsRepository.findOne({
      where: { user_id: userId },
    });

    if (!settings) {
      settings = this.settingsRepository.create({
        user_id: userId,
        sms_enabled: true,
        email_enabled: false,
        push_enabled: false,
        notify_parent_on_attendance: true,
        notify_parent_on_exam_grade: true,
        notify_parent_on_lesson_expiry: true,
        notify_on_purchase: true,
      });
      settings = await this.settingsRepository.save(settings);
    }

    return settings;
  }

  /**
   * Update notification settings for a user
   */
  public async updateSettings(
    userId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettings> {
    const settings = await this.getOrCreateSettings(userId);

    // Update only provided fields
    if (dto.sms_enabled !== undefined) {
      settings.sms_enabled = dto.sms_enabled;
    }
    if (dto.email_enabled !== undefined) {
      settings.email_enabled = dto.email_enabled;
    }
    if (dto.push_enabled !== undefined) {
      settings.push_enabled = dto.push_enabled;
    }
    if (dto.notify_parent_on_attendance !== undefined) {
      settings.notify_parent_on_attendance = dto.notify_parent_on_attendance;
    }
    if (dto.notify_parent_on_exam_grade !== undefined) {
      settings.notify_parent_on_exam_grade = dto.notify_parent_on_exam_grade;
    }
    if (dto.notify_parent_on_lesson_expiry !== undefined) {
      settings.notify_parent_on_lesson_expiry = dto.notify_parent_on_lesson_expiry;
    }
    if (dto.notify_on_purchase !== undefined) {
      settings.notify_on_purchase = dto.notify_on_purchase;
    }

    return await this.settingsRepository.save(settings);
  }
}
