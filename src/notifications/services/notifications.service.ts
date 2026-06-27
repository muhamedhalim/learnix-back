import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { StudentProfile } from '../../students/entities/student-profile.entity';
import {
  NotificationFilterDto,
  SendNotificationDto,
  UpdateNotificationSettingsDto,
} from '../dto';
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
    @InjectRepository(StudentProfile)
    private readonly studentProfilesRepository: Repository<StudentProfile>,
    private readonly smsSenderService: SmsSenderService,
  ) {}

  /**
   * Create and send a notification
   */
  public async create(
    dto: SendNotificationDto,
    sendSms = true,
  ): Promise<Notification> {
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

    // Send SMS if requested
    if (sendSms && dto.send_sms !== false) {
      await this.trySendSms(saved);
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
        `Notification with ID ${notificationId} not found`,
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
  public async retryNotification(
    notificationId: string,
  ): Promise<Notification> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new NotFoundException(
        `Notification with ID ${notificationId} not found`,
      );
    }

    if (notification.status !== NotificationStatus.FAILED) {
      throw new BadRequestException(
        `Cannot retry notification with status '${notification.status}'. Only failed notifications can be retried.`,
      );
    }

    // Increment attempts and reset status to pending
    notification.attempts += 1;
    notification.status = NotificationStatus.PENDING;
    notification.error_message = null;
    notification.sent_at = new Date();

    await this.notificationsRepository.save(notification);

    // Attempt to resend SMS
    await this.trySendSms(notification);

    // Reload and return updated notification
    const updated = await this.notificationsRepository.findOne({
      where: { id: notificationId },
    });

    return updated ?? notification;
  }

  /**
   * Attempt to send SMS for a notification
   * Updates status tracking fields based on result
   */
  private async trySendSms(notification: Notification): Promise<void> {
    // Increment attempts locally
    const currentAttempts = notification.attempts + 1;

    // Get user settings
    const settings = await this.getOrCreateSettings(notification.user_id);

    // Check if SMS is enabled and if this notification type should trigger SMS
    if (!settings.sms_enabled) {
      this.logger.debug(`SMS disabled for user ${notification.user_id}`);
      // Mark as sent (no SMS needed)
      await this.notificationsRepository.update(notification.id, {
        status: NotificationStatus.SENT,
        attempts: currentAttempts,
      });
      return;
    }

    if (!this.shouldSendSmsForType(notification.type, settings)) {
      this.logger.debug(
        `SMS not enabled for type ${notification.type} for user ${notification.user_id}`,
      );
      // Mark as sent (no SMS needed for this type)
      await this.notificationsRepository.update(notification.id, {
        status: NotificationStatus.SENT,
        attempts: currentAttempts,
      });
      return;
    }

    // Get parent phone number
    const parentPhone = await this.getParentPhone(
      notification.user_id,
      settings,
    );

    if (parentPhone !== null && parentPhone !== '') {
      try {
        // Send SMS
        const result = await this.smsSenderService.sendSms(
          parentPhone,
          notification.message,
        );

        if (result.success) {
          await this.notificationsRepository.update(notification.id, {
            sms_sent: true,
            sms_to: parentPhone,
            status: NotificationStatus.DELIVERED,
            attempts: currentAttempts,
            delivered_at: new Date(),
            error_message: null,
          });
          this.logger.log(
            `SMS delivered for notification ${notification.id} to ${parentPhone}`,
          );
        } else {
          // SMS send returned failure
          const errorMessage = result.error ?? 'SMS delivery failed';
          await this.notificationsRepository.update(notification.id, {
            sms_to: parentPhone,
            status: NotificationStatus.FAILED,
            attempts: currentAttempts,
            error_message: errorMessage,
          });
          this.logger.warn(
            `SMS failed for notification ${notification.id}: ${errorMessage}`,
          );
        }
      } catch (error) {
        // Exception during SMS send
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        await this.notificationsRepository.update(notification.id, {
          sms_to: parentPhone,
          status: NotificationStatus.FAILED,
          attempts: currentAttempts,
          error_message: errorMessage,
        });
        this.logger.error(
          `SMS exception for notification ${notification.id}: ${errorMessage}`,
        );
      }
    } else {
      // No parent phone - mark as sent but log warning
      await this.notificationsRepository.update(notification.id, {
        status: NotificationStatus.SENT,
        attempts: currentAttempts,
        error_message: 'No parent phone number available',
      });
      this.logger.warn(
        `No parent phone for user ${notification.user_id}, marked as sent`,
      );
    }
  }

  /**
   * Check if SMS should be sent for a notification type
   */
  private shouldSendSmsForType(
    type: NotificationType,
    settings: NotificationSettings,
  ): boolean {
    switch (type) {
      case NotificationType.ATTENDANCE:
        return settings.notify_parent_on_attendance;
      case NotificationType.EXAM_RESULT:
        return settings.notify_parent_on_exam_grade;
      case NotificationType.LESSON_EXPIRING:
        return settings.notify_parent_on_lesson_expiry;
      case NotificationType.PURCHASE:
        return settings.notify_on_purchase;
      case NotificationType.CUSTOM:
        return true; // Admin custom notifications always send if SMS enabled
    }
  }

  /**
   * Get parent phone number (from settings override or student profile)
   */
  private async getParentPhone(
    userId: string,
    settings: NotificationSettings,
  ): Promise<string | null> {
    // Check for override in settings
    if (
      settings.parent_phone_override !== null &&
      settings.parent_phone_override !== ''
    ) {
      return settings.parent_phone_override;
    }

    // Get from student profile
    const profile = await this.studentProfilesRepository.findOne({
      where: { user_id: userId },
    });

    return profile?.parent_phone ?? null;
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
    const [data, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

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
  public async markAsRead(
    notificationId: string,
    userId: string,
  ): Promise<Notification> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId, user_id: userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
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
  public async getOrCreateSettings(
    userId: string,
  ): Promise<NotificationSettings> {
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
    if (dto.parent_phone_override !== undefined) {
      settings.parent_phone_override =
        dto.parent_phone_override === '' ? null : dto.parent_phone_override;
    }
    if (dto.notify_parent_on_attendance !== undefined) {
      settings.notify_parent_on_attendance = dto.notify_parent_on_attendance;
    }
    if (dto.notify_parent_on_exam_grade !== undefined) {
      settings.notify_parent_on_exam_grade = dto.notify_parent_on_exam_grade;
    }
    if (dto.notify_parent_on_lesson_expiry !== undefined) {
      settings.notify_parent_on_lesson_expiry =
        dto.notify_parent_on_lesson_expiry;
    }
    if (dto.notify_on_purchase !== undefined) {
      settings.notify_on_purchase = dto.notify_on_purchase;
    }

    return await this.settingsRepository.save(settings);
  }
}
