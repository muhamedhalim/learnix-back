import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import {
  ADMIN_NOTIFICATION_CATALOG,
  AdminNotificationEvent,
} from '../constants/admin-notification-events';
import { AdminNotificationCategory } from '../entities/admin-notification-category.enum';
import { NotificationOrigin } from '../entities/notification-origin.enum';
import { NotificationPriority } from '../entities/notification-priority.enum';
import { NotificationType } from '../entities/notification-type.enum';
import { NotificationsService } from './notifications.service';

/** Never fan a single alert out to more admins than this. */
const MAX_ADMIN_RECIPIENTS = 100;

export interface NotifyAdminsParams {
  title: string;
  message: string;
  /** Deep link to where the admin takes action. */
  link?: string;
  data?: Record<string, unknown>;
  /** Overrides the event's catalog default. */
  priority?: NotificationPriority;
  /** Overrides the event's catalog default. */
  category?: AdminNotificationCategory;
  /**
   * When provided, one row per admin is deduplicated on
   * `${event}:${dedupeKey}:${adminId}` — safe to call repeatedly (e.g. from a
   * cron) for the same underlying fact. Omit for events that should always
   * produce a fresh row (this preserves `OperationalAlertService`'s existing
   * behaviour of recording every dispatch).
   */
  dedupeKey?: string;
}

/**
 * The single non-transactional creation path for admin-facing notifications.
 *
 * Every caller here is EITHER a cataloged `AdminNotificationEvent` — see that
 * file for the full allow-list and why it exists — the read-time filter in
 * `NotificationsService.findAllForUser` trusts that nothing reaches an
 * admin's inbox through this class without going through the catalog.
 *
 * A DB-transactional caller (currently only `ManualPaymentsService`, which
 * already holds an `EntityManager` and cannot go through
 * `NotificationsService.create()`) cannot use this class and instead imports
 * `ADMIN_NOTIFICATION_CATALOG` directly for its priority/category defaults.
 */
@Injectable()
export class AdminNotificationsService {
  public constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
  ) {}

  public async notifyAdmins(
    event: AdminNotificationEvent,
    params: NotifyAdminsParams,
  ): Promise<void> {
    const defaults = ADMIN_NOTIFICATION_CATALOG[event];
    const priority = params.priority ?? defaults.priority;
    const category = params.category ?? defaults.category;
    const data =
      params.link !== undefined ? { href: params.link, ...(params.data ?? {}) } : params.data;

    const admins = await this.users.find({
      where: { role: UserRole.ADMIN, is_active: true },
      select: { id: true },
      take: MAX_ADMIN_RECIPIENTS,
    });

    await Promise.allSettled(
      admins.map(async (admin) =>
        this.notifications.create(
          {
            user_id: admin.id,
            type: NotificationType.CUSTOM,
            title: params.title,
            message: params.message,
            ...(data === undefined ? {} : { data }),
            priority,
            category,
            ...(params.link === undefined ? {} : { link: params.link }),
            send_sms: false,
          },
          false,
          {
            origin: NotificationOrigin.OPERATIONAL,
            sourceEvent: event,
            ...(params.dedupeKey !== undefined
              ? { dedupeKey: `${event}:${params.dedupeKey}:${admin.id}` }
              : {}),
          },
        ),
      ),
    );
  }
}
