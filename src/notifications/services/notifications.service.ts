import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { StudentProfile } from '../../students/entities/student-profile.entity';
import {
  NotificationFilterDto,
  SendNotificationDto,
  UpdateNotificationSettingsDto,
} from '../dto';
import {
  Notification,
  NotificationSettings,
  NotificationType,
} from '../entities';
import { SmsSenderService } from './sms-sender.service';
import { Repository } from 'typeorm';

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
    });

    const saved = await this.notificationsRepository.save(notification);

    // Send SMS if requested
    if (sendSms && dto.send_sms !== false) {
      await this.trySendSms(saved);
    }

    return saved;
  }

  /**
   * Attempt to send SMS for a notification
   */
  private async trySendSms(notification: Notification): Promise<void> {
    // Get user settings
    const settings = await this.getOrCreateSettings(notification.user_id);

    // Check if SMS is enabled and if this notification type should trigger SMS
    if (!settings.sms_enabled) {
      this.logger.debug(`SMS disabled for user ${notification.user_id}`);
      return;
    }

    if (!this.shouldSendSmsForType(notification.type, settings)) {
      this.logger.debug(
        `SMS not enabled for type ${notification.type} for user ${notification.user_id}`,
      );
      return;
    }

    // Get parent phone number
    const parentPhone = await this.getParentPhone(
      notification.user_id,
      settings,
    );

    if (parentPhone !== null && parentPhone !== '') {
      // Send SMS
      const result = await this.smsSenderService.sendSms(
        parentPhone,
        notification.message,
      );

      if (result.success) {
        await this.notificationsRepository.update(notification.id, {
          sms_sent: true,
          sms_to: parentPhone,
        });
      }
    } else {
      this.logger.warn(
        `No parent phone for user ${notification.user_id}, skipping SMS`,
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
        dto.parent_phone_override !== '' ? dto.parent_phone_override : null;
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
