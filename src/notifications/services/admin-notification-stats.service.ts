import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { MailService } from '../../mail/mail.service';
import { areQueuesEnabled } from '../../queues/queues.constants';
import {
  Notification,
  NotificationCampaign,
  NotificationDelivery,
  NotificationDeliveryStatus,
} from '../entities';
import { PushDispatchService } from './push-dispatch.service';
import { SmsSenderService } from './sms-sender.service';

/**
 * Read-only statistics for the admin notifications dashboard (`GET admin/notifications/stats`):
 * volume, read rate, per-type / campaign / delivery breakdowns and channel readiness.
 * Moved unchanged out of `AdminNotificationsController`, which now only wraps the result.
 */
@Injectable()
export class AdminNotificationStatsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(NotificationCampaign)
    private readonly campaigns: Repository<NotificationCampaign>,
    @InjectRepository(NotificationDelivery)
    private readonly deliveries: Repository<NotificationDelivery>,
    private readonly smsSender: SmsSenderService,
    private readonly pushDispatch: PushDispatchService,
    private readonly mail: MailService,
  ) {}

  public async getStatistics(): Promise<Record<string, unknown>> {
    const totalNotifications = await this.notifications.count();
    const readNotifications = await this.notifications.count({
      where: { is_read: true },
    });
    const smsSent = await this.notifications.count({
      where: { sms_sent: true },
    });

    // Count by type
    interface TypeStatRaw {
      type: string;
      count: string;
    }
    const typeStats = await this.notifications
      .createQueryBuilder('notification')
      .select('notification.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('notification.type')
      .getRawMany<TypeStatRaw>();

    // Notifications in last 24 hours
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const last24Hours = await this.notifications
      .createQueryBuilder('notification')
      .where('notification.sent_at >= :date', { date: oneDayAgo })
      .getCount();

    // Notifications in last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const last7Days = await this.notifications
      .createQueryBuilder('notification')
      .where('notification.sent_at >= :date', { date: sevenDaysAgo })
      .getCount();

    const [campaignStats, deliveryStats, needsAttention] = await Promise.all([
      this.campaigns
        .createQueryBuilder('campaign')
        .select('campaign.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('campaign.status')
        .getRawMany<{ status: string; count: string }>(),
      this.deliveries
        .createQueryBuilder('delivery')
        .select('delivery.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('delivery.status')
        .getRawMany<{ status: string; count: string }>(),
      this.deliveries.count({
        where: [
          { status: NotificationDeliveryStatus.FAILED },
          { status: NotificationDeliveryStatus.PROVIDER_UNAVAILABLE },
        ],
      }),
    ]);
    const pushReadiness = this.pushDispatch.readiness();

    return {
      total_notifications: totalNotifications,
      read_notifications: readNotifications,
      unread_notifications: totalNotifications - readNotifications,
      read_rate:
        totalNotifications > 0 ? Math.round((readNotifications / totalNotifications) * 100) : 0,
      sms_sent: smsSent,
      sms_enabled: this.smsSender.isConfigured(),
      by_type: typeStats.reduce<Record<string, number>>((acc, item) => {
        acc[item.type] = Number.parseInt(item.count);
        return acc;
      }, {}),
      last_24_hours: last24Hours,
      last_7_days: last7Days,
      campaigns: campaignStats.reduce<Record<string, number>>((acc, item) => {
        acc[item.status] = Number.parseInt(item.count, 10);
        return acc;
      }, {}),
      deliveries: deliveryStats.reduce<Record<string, number>>((acc, item) => {
        acc[item.status] = Number.parseInt(item.count, 10);
        return acc;
      }, {}),
      needs_attention: needsAttention,
      readiness: {
        queues: areQueuesEnabled(),
        push: pushReadiness.configured,
        push_provider: pushReadiness.provider,
        email: this.mail.isConfigured(),
        sms: this.smsSender.isConfigured(),
      },
    };
  }
}
