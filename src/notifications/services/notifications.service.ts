import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { maskPhone } from '../../common/utils/mask.util';
import { GuardiansService } from '../../guardians/guardians.service';
import { PreferredLanguage } from '../../guardians/entities/preferred-language.enum';
import { biBody } from '../../i18n/error-translator.util';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import {
  AdminNotificationFilterDto,
  NotificationFilterDto,
  SendNotificationDto,
  UpdateNotificationSettingsDto,
} from '../dto';
import {
  Notification,
  NotificationChannel,
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationOrigin,
  NotificationSettings,
  NotificationStatus,
  NotificationType,
} from '../entities';
import { NotificationChannelPolicyService } from './notification-channel-policy.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { PushNotificationJobsService } from './push-notification-jobs.service';
import { SmsSenderService } from './sms-sender.service';

export interface PaginatedNotifications<T = Notification> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export type SupportTicketNotificationEvent =
  | 'created'
  | 'new_ticket'
  | 'user_reply'
  | 'assigned'
  | 'agent_reply'
  | 'waiting_for_user'
  | 'escalated'
  | 'resolved'
  | 'closed'
  | 'reopened'
  | 'sla_first_response_warning'
  | 'sla_first_response_exceeded'
  | 'sla_resolution_warning'
  | 'sla_resolution_exceeded';

interface NotificationCreateOptions {
  dedupeKey?: string;
  origin?: NotificationOrigin;
  sourceEvent?: string;
  createdByUserId?: string;
  campaignId?: string;
  /**
   * Fan the persisted notification out to the recipient's registered push
   * devices. Default `true`: an in-app notification is *the* notification, and
   * push is one of its transports. Enforcement of `push_enabled` happens inside
   * `PushDispatchService`, never here — one policy chokepoint, not two.
   *
   * Set `false` only for records that are not user-facing announcements.
   */
  push?: boolean;
}

export interface AdminNotificationView {
  id: string;
  campaign_id: string | null;
  type: NotificationType;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  legacy_status: NotificationStatus;
  in_app_state: 'published';
  read_state: 'read' | 'unread';
  is_read: boolean;
  origin: NotificationOrigin;
  source_event: string | null;
  sent_at: Date;
  read_at: Date | null;
  created_at: Date;
  recipient: { id: string; name: string; email: string; role: string };
  created_by: { id: string; name: string; email: string } | null;
  deliveries: AdminNotificationDeliveryView[];
}

export interface AdminNotificationDeliveryView {
  id: string;
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
  provider: string | null;
  provider_message_id: string | null;
  attempts: number;
  error_message: string | null;
  sent_at: Date | null;
  created_at: Date;
}

function toAdminDeliveryView(delivery: NotificationDelivery): AdminNotificationDeliveryView {
  return {
    id: delivery.id,
    channel: delivery.channel,
    status: delivery.status,
    provider: delivery.provider,
    provider_message_id: delivery.provider_message_id,
    attempts: delivery.attempts,
    error_message: delivery.error_message,
    sent_at: delivery.sent_at,
    created_at: delivery.created_at,
  };
}

const SUPPORT_TICKET_COPY: Readonly<
  Record<
    SupportTicketNotificationEvent,
    { title: string; message: (ticketNumber: string) => string }
  >
> = {
  created: {
    title: 'Support request received',
    message: (number) => `Your support request ${number} has been received.`,
  },
  new_ticket: {
    title: 'New support ticket',
    message: (number) => `A new support ticket ${number} is waiting in the queue.`,
  },
  user_reply: {
    title: 'Customer replied',
    message: (number) => `The customer replied on support ticket ${number}.`,
  },
  assigned: {
    title: 'Ticket assigned',
    message: (number) => `You have been assigned support ticket ${number}.`,
  },
  agent_reply: {
    title: 'Support reply received',
    message: (number) => `There is a new reply on support ticket ${number}.`,
  },
  waiting_for_user: {
    title: 'Support information needed',
    message: (number) => `Support is waiting for your reply on ticket ${number}.`,
  },
  escalated: {
    title: 'Support request under review',
    message: (number) => `Your support ticket ${number} is under additional review.`,
  },
  resolved: {
    title: 'Support request resolved',
    message: (number) => `Support ticket ${number} has been resolved.`,
  },
  closed: {
    title: 'Support request closed',
    message: (number) => `Support ticket ${number} has been closed.`,
  },
  reopened: {
    title: 'Support request reopened',
    message: (number) => `Support ticket ${number} has been reopened.`,
  },
  sla_first_response_warning: {
    title: 'First response SLA nearing',
    message: (number) => `Ticket ${number} is nearing its first-response SLA deadline.`,
  },
  sla_first_response_exceeded: {
    title: 'First response SLA exceeded',
    message: (number) => `Ticket ${number} exceeded its first-response SLA deadline.`,
  },
  sla_resolution_warning: {
    title: 'Resolution SLA nearing',
    message: (number) => `Ticket ${number} is nearing its resolution SLA deadline.`,
  },
  sla_resolution_exceeded: {
    title: 'Resolution SLA exceeded',
    message: (number) => `Ticket ${number} exceeded its resolution SLA deadline.`,
  },
};

const SUPPORT_TICKET_COPY_AR: Readonly<
  Record<
    SupportTicketNotificationEvent,
    { title: string; message: (ticketNumber: string) => string }
  >
> = {
  created: { title: 'تم استلام طلب الدعم', message: (number) => `تم استلام طلب الدعم ${number}.` },
  new_ticket: {
    title: 'تذكرة دعم جديدة',
    message: (number) => `توجد تذكرة دعم جديدة ${number} في قائمة الانتظار.`,
  },
  user_reply: {
    title: 'رد صاحب التذكرة',
    message: (number) => `رد صاحب التذكرة على طلب الدعم ${number}.`,
  },
  assigned: {
    title: 'تم تعيين التذكرة',
    message: (number) => `تم تعيين تذكرة الدعم ${number} إليك.`,
  },
  agent_reply: {
    title: 'وصل رد من الدعم',
    message: (number) => `يوجد رد جديد في تذكرة الدعم ${number}.`,
  },
  waiting_for_user: {
    title: 'مطلوب معلومات للدعم',
    message: (number) => `ينتظر الدعم ردك على التذكرة ${number}.`,
  },
  escalated: {
    title: 'طلب الدعم قيد المراجعة',
    message: (number) => `تذكرة الدعم ${number} قيد مراجعة إضافية.`,
  },
  resolved: { title: 'تم حل طلب الدعم', message: (number) => `تم حل تذكرة الدعم ${number}.` },
  closed: { title: 'تم إغلاق طلب الدعم', message: (number) => `تم إغلاق تذكرة الدعم ${number}.` },
  reopened: {
    title: 'تمت إعادة فتح طلب الدعم',
    message: (number) => `تمت إعادة فتح تذكرة الدعم ${number}.`,
  },
  sla_first_response_warning: {
    title: 'اقترب موعد الرد الأول',
    message: (number) => `اقترب موعد الرد الأول لتذكرة ${number}.`,
  },
  sla_first_response_exceeded: {
    title: 'تجاوز موعد الرد الأول',
    message: (number) => `تجاوزت التذكرة ${number} موعد الرد الأول.`,
  },
  sla_resolution_warning: {
    title: 'اقترب موعد الحل',
    message: (number) => `اقترب موعد حل التذكرة ${number}.`,
  },
  sla_resolution_exceeded: {
    title: 'تجاوز موعد الحل',
    message: (number) => `تجاوزت التذكرة ${number} موعد الحل.`,
  },
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly guardiansService: GuardiansService,
    private readonly smsSenderService: SmsSenderService,
    private readonly channelPolicy: NotificationChannelPolicyService,
    private readonly pushJobs: PushNotificationJobsService,
    private readonly notificationDeliveries: NotificationDeliveryService,
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
  public async create(
    dto: SendNotificationDto,
    sendSms = true,
    options: NotificationCreateOptions = {},
  ): Promise<Notification> {
    if (options.dedupeKey !== undefined) {
      const existing = await this.notificationsRepository.findOneBy({
        dedupe_key: options.dedupeKey,
      });
      if (existing) {
        return existing;
      }
    }
    const now = new Date();

    // Create notification record
    const notification = this.notificationsRepository.create({
      dedupe_key: options.dedupeKey ?? null,
      campaign_id: options.campaignId ?? null,
      created_by_user_id: options.createdByUserId ?? null,
      origin: options.origin ?? NotificationOrigin.SYSTEM,
      source_event: options.sourceEvent ?? null,
      user_id: dto.user_id,
      type: dto.type,
      title: dto.title,
      message: dto.message,
      data: dto.data ?? null,
      is_read: false,
      sent_at: now,
      sms_sent: false,
      sms_to: null,
      // The parent row represents an in-app record, not provider delivery.
      // Once saved it is locally published; channel outcomes live in
      // notification_deliveries.
      status: NotificationStatus.SENT,
      attempts: 0,
      error_message: null,
      delivered_at: null,
    });

    let saved: Notification;
    try {
      saved = await this.notificationsRepository.save(notification);
    } catch (error: unknown) {
      if (options.dedupeKey === undefined || (error as { code?: string }).code !== '23505') {
        throw error;
      }
      const existing = await this.notificationsRepository.findOneBy({
        dedupe_key: options.dedupeKey,
      });
      if (!existing) {
        throw error;
      }
      return existing;
    }

    // Fan out to guardians if requested.
    if (sendSms && dto.send_sms !== false) {
      await this.dispatchToGuardians(saved);
    }

    // Fan out to the recipient's own devices. Enqueued rather than awaited on
    // the provider, and never allowed to fail the caller: a push problem must
    // not roll back the exam grade or homework submission that produced this.
    if (options.push !== false) {
      try {
        await this.pushJobs.enqueueDelivery(saved.id);
      } catch (error) {
        this.logger.warn(
          `Failed to enqueue push for notification ${saved.id}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return saved;
  }

  /**
   * Ticket notifications are in-app only. They deliberately reuse the
   * established notification persistence and status lifecycle rather than
   * introducing a support dispatcher or exposing a provider operation.
   */
  public async createSupportTicketNotification(
    recipientUserId: string,
    ticket: { id: string; ticket_number: string; version: number },
    event: SupportTicketNotificationEvent,
  ): Promise<Notification> {
    const recipient = await this.usersRepository.findOne({
      where: { id: recipientUserId },
      select: ['id', 'preferred_language', 'role'],
    });
    const copy =
      recipient?.preferred_language === PreferredLanguage.AR
        ? SUPPORT_TICKET_COPY_AR[event]
        : SUPPORT_TICKET_COPY[event];
    const href = recipient?.role === UserRole.CALL_CENTER
      ? `/call-center/tickets/${ticket.id}`
      : recipient?.role === UserRole.ADMIN
        ? `/admin/complaints?ticket=${ticket.id}`
        : recipient?.role === UserRole.TEACHER
          ? `/teacher/complaints?ticket=${ticket.id}`
          : `/student/complaints?ticket=${ticket.id}`;
    const notification = await this.create(
      {
        user_id: recipientUserId,
        type: NotificationType.CUSTOM,
        title: copy.title,
        message: copy.message(ticket.ticket_number),
        data: {
          href,
          support_ticket: {
            id: ticket.id,
            number: ticket.ticket_number,
            event,
          },
        },
        send_sms: false,
      },
      false,
      { dedupeKey: `support-ticket:${ticket.id}:${event}:${ticket.version}` },
    );
    // Support events are in-app-only. Mark their local dispatch state as sent
    // without invoking any provider or exposing a retry/transport operation.
    return notification;
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
    legacy_status: NotificationStatus;
    attempts: number;
    error_message: string | null;
    sms_sent: boolean;
    sms_to: string | null;
    sent_at: Date;
    delivered_at: Date | null;
    read_at: Date | null;
    is_read: boolean;
    created_at: Date;
    in_app_state: 'published';
    read_state: 'read' | 'unread';
    origin: NotificationOrigin;
    source_event: string | null;
    campaign_id: string | null;
    created_by: { id: string; name: string; email: string } | null;
    deliveries: AdminNotificationDeliveryView[];
    user: {
      id: string;
      name: string;
      email: string;
    };
    recipient: {
      id: string;
      name: string;
      email: string;
      role: string;
    };
  }> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId },
      relations: { user: true, created_by: true },
    });
    if (!notification) {
      throw new NotFoundException(
        biBody('Notification not found', 'Notification not found'),
      );
    }
    const deliveries = await this.notificationDeliveries.findForNotification(notificationId);

    return {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      status: notification.status,
      legacy_status: notification.status,
      attempts: notification.attempts,
      error_message: notification.error_message,
      sms_sent: notification.sms_sent,
      sms_to: notification.sms_to,
      sent_at: notification.sent_at,
      delivered_at: notification.delivered_at,
      read_at: notification.read_at,
      is_read: notification.is_read,
      created_at: notification.created_at,
      in_app_state: 'published',
      read_state: notification.is_read ? 'read' : 'unread',
      origin: notification.origin,
      source_event: notification.source_event,
      campaign_id: notification.campaign_id,
      created_by: notification.created_by
        ? {
            id: notification.created_by.id,
            name: notification.created_by.name,
            email: notification.created_by.email,
          }
        : null,
      deliveries: deliveries.map(toAdminDeliveryView),
      user: {
        id: notification.user.id,
        name: notification.user.name,
        email: notification.user.email,
      },
      recipient: {
        id: notification.user.id,
        name: notification.user.name,
        email: notification.user.email,
        role: notification.user.role,
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

    // Channel policy, via the single chokepoint. Behaviour is unchanged from
    // the inline `settings.sms_enabled` check this replaces — the student's SMS
    // preference has always gated the guardian fan-out — but it is now the same
    // check the modern queue-backed pipeline makes, so the toggle cannot mean
    // one thing on one path and nothing on the other.
    const smsAllowed = await this.channelPolicy.isAllowed(
      notification.user_id,
      NotificationChannel.SMS,
    );
    if (!smsAllowed) {
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
   * Admin-wide notification listing: every user's in-app notifications, with
   * the same filters as the per-user view plus free-text search and optional
   * recipient narrowing. The recipient is joined so the admin table can show
   * who each notification went to (password-bearing columns are `select: false`
   * on the entity and are never loaded).
   */
  public async findAllAdmin(
    filter: AdminNotificationFilterDto,
  ): Promise<PaginatedNotifications<AdminNotificationView>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.notificationsRepository
      .createQueryBuilder('notification')
      .leftJoin('notification.user', 'user')
      .addSelect(['user.id', 'user.name', 'user.email', 'user.role'])
      .leftJoin('notification.created_by', 'creator')
      .addSelect(['creator.id', 'creator.name', 'creator.email'])
      .leftJoinAndSelect('notification.deliveries', 'delivery')
      .distinct(true);

    if (filter.needs_attention === true) {
      queryBuilder.andWhere('delivery.status IN (:...attentionStatuses)', {
        attentionStatuses: [
          NotificationDeliveryStatus.FAILED,
          NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
        ],
      });
    }

    if (filter.user_id !== undefined) {
      queryBuilder.andWhere('notification.user_id = :userId', { userId: filter.user_id });
    }

    if (filter.type !== undefined) {
      queryBuilder.andWhere('notification.type = :type', { type: filter.type });
    }

    if (filter.is_read !== undefined) {
      queryBuilder.andWhere('notification.is_read = :isRead', { isRead: filter.is_read });
    }

    if (filter.sms_sent !== undefined) {
      queryBuilder.andWhere('notification.sms_sent = :smsSent', { smsSent: filter.sms_sent });
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

    if (filter.search !== undefined && filter.search.trim() !== '') {
      queryBuilder.andWhere(
        '(notification.title ILIKE :search OR notification.message ILIKE :search ' +
          'OR user.name ILIKE :search OR user.email ILIKE :search)',
        { search: `%${filter.search.trim()}%` },
      );
    }

    queryBuilder.orderBy('notification.sent_at', 'DESC');

    const [entities, total] = await queryBuilder.skip(skip).take(limit).getManyAndCount();
    const data: AdminNotificationView[] = entities.map((notification) => ({
      id: notification.id,
      campaign_id: notification.campaign_id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      legacy_status: notification.status,
      in_app_state: 'published',
      read_state: notification.is_read ? 'read' : 'unread',
      is_read: notification.is_read,
      origin: notification.origin,
      source_event: notification.source_event,
      sent_at: notification.sent_at,
      read_at: notification.read_at,
      created_at: notification.created_at,
      recipient: {
        id: notification.user.id,
        name: notification.user.name,
        email: notification.user.email,
        role: notification.user.role,
      },
      created_by: notification.created_by
        ? {
            id: notification.created_by.id,
            name: notification.created_by.name,
            email: notification.created_by.email,
          }
        : null,
      deliveries: (notification.deliveries ?? []).map(toAdminDeliveryView),
    }));
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
   * Get or create notification settings for a user.
   *
   * Delegates to `NotificationChannelPolicyService`, which owns the settings
   * row. Kept here because existing callers (the settings controller, specs)
   * address it through this service — but there is exactly one implementation,
   * so what the Settings screen reads and what a dispatcher enforces cannot
   * diverge.
   */
  public async getOrCreateSettings(userId: string): Promise<NotificationSettings> {
    return await this.channelPolicy.getOrCreateSettings(userId);
  }

  /**
   * Update notification settings for a user.
   *
   * Channel fields only. The four `notify_parent_on_*` names the DTO still
   * accepts are deprecated no-ops — guardian event preferences live on the
   * guardian link (`PUT /student/guardians/:guardianId/preferences`). See
   * `UpdateNotificationSettingsDto` and migration 2079000000000.
   */
  public async updateSettings(
    userId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettings> {
    return await this.channelPolicy.updateSettings(userId, dto);
  }
}
