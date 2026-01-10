import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Notification,
  NotificationSettings,
  NotificationType,
} from '../entities';
import {
  SendNotificationDto,
  UpdateNotificationSettingsDto,
  NotificationFilterDto,
} from '../dto';
import { SmsSenderService } from './sms-sender.service';
import { StudentProfile } from '../../students/entities/student-profile.entity';

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
  async create(
    dto: SendNotificationDto,
    sendSms: boolean = true,
  ): Promise<Notification> {
    const now = new Date();

    // Create notification record
    const notification = this.notificationsRepository.create({
      user_id: dto.user_id,
      type: dto.type,
      title: dto.title,
      message: dto.message,
      data: dto.data || null,
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

    if (!parentPhone) {
      this.logger.warn(
        `No parent phone for user ${notification.user_id}, skipping SMS`,
      );
      return;
    }

    // Send SMS
    const result = await this.smsSenderService.sendSms(
      parentPhone,
      notification.message,
    );

    if (result.success) {
      notification.sms_sent = true;
      notification.sms_to = parentPhone;
      await this.notificationsRepository.save(notification);
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
      default:
        return true;
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
    if (settings.parent_phone_override) {
      return settings.parent_phone_override;
    }

    // Get from student profile
    const profile = await this.studentProfilesRepository.findOne({
      where: { user_id: userId },
    });

    return profile?.parent_phone || null;
  }

  /**
   * Get paginated notifications for a user
   */
  async findAllForUser(
    userId: string,
    filter: NotificationFilterDto,
  ): Promise<PaginatedNotifications> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.notificationsRepository
      .createQueryBuilder('notification')
      .where('notification.user_id = :userId', { userId });

    // Apply filters
    if (filter.type) {
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

    if (filter.sent_after) {
      queryBuilder.andWhere('notification.sent_at >= :sentAfter', {
        sentAfter: new Date(filter.sent_after),
      });
    }

    if (filter.sent_before) {
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
  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationsRepository.count({
      where: { user_id: userId, is_read: false },
    });
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(
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
      return this.notificationsRepository.save(notification);
    }

    return notification;
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<{ count: number }> {
    const result = await this.notificationsRepository.update(
      { user_id: userId, is_read: false },
      { is_read: true, read_at: new Date() },
    );

    return { count: result.affected || 0 };
  }

  /**
   * Get or create notification settings for a user
   */
  async getOrCreateSettings(userId: string): Promise<NotificationSettings> {
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
  async updateSettings(
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
      settings.parent_phone_override = dto.parent_phone_override || null;
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

    return this.settingsRepository.save(settings);
  }
}
