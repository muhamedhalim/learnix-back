import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { FEATURE_FLAGS, isFeatureEnabled } from '../../config/feature-flags';
import { areQueuesEnabled } from '../../queues/queues.constants';
import { Notification, NotificationChannel, NotificationOrigin } from '../entities';
import { PushNotificationJobsService } from './push-notification-jobs.service';
import { CronSingleRunner } from '../../common/utils/cron-lock.util';

/**
 * Recovery net for the database/queue boundary.
 *
 * A notification is committed before push is queued so a Redis outage can
 * never roll back the domain transaction. This scanner closes the other side
 * of that trade-off: recently-published, non-legacy rows with no recorded push
 * decision are re-enqueued after Redis or the API process recovers.
 */
@Injectable()
export class NotificationDispatchRecoveryService {
  private readonly logger = new Logger(NotificationDispatchRecoveryService.name);
  private running = false;

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly pushJobs: PushNotificationJobsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  @CronSingleRunner('notifications.recover_push_decisions')
  public async recoverMissingPushDecisions(): Promise<number> {
    if (
      this.running ||
      !areQueuesEnabled() ||
      !isFeatureEnabled(FEATURE_FLAGS.NOTIFICATIONS)
    ) {
      return 0;
    }

    this.running = true;
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await this.notifications
        .createQueryBuilder('notification')
        .select('notification.id', 'id')
        .where('notification.sent_at >= :since', { since })
        .andWhere('notification.origin <> :legacy', {
          legacy: NotificationOrigin.LEGACY_UNKNOWN,
        })
        .andWhere(
          `NOT EXISTS (
            SELECT 1 FROM notification_deliveries delivery
            WHERE delivery.notification_id = notification.id
              AND delivery.channel = :channel
          )`,
          { channel: NotificationChannel.PUSH },
        )
        .orderBy('notification.sent_at', 'ASC')
        .addOrderBy('notification.id', 'ASC')
        .limit(200)
        .getRawMany<{ id: string }>();

      for (const row of rows) {
        await this.pushJobs.enqueueDelivery(row.id, { forceNewJob: true });
      }
      if (rows.length > 0) {
        this.logger.log(`Recovered ${rows.length.toString()} notification push decision(s)`);
      }
      return rows.length;
    } finally {
      this.running = false;
    }
  }
}
