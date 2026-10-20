import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Job, Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { PreferredLanguage } from '../../guardians/entities/preferred-language.enum';
import {
  Notification,
  NotificationCampaign,
  NotificationCampaignStatus,
  NotificationOrigin,
  NotificationStatus,
  NotificationType,
} from '../../notifications/entities';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { queueJobId } from '../../queues/job-id.util';
import { User } from '../../users/entities/user.entity';
import { UserStatus } from '../../users/entities/user-status.enum';
import type { BulkNotificationDto } from '../dto';

interface BulkNotificationJob {
  dto: BulkNotificationDto;
  adminId: string;
  campaignId: string;
}

const RECIPIENT_BATCH_SIZE = 500;

@Processor(QUEUE_NAMES.BULK_NOTIFICATIONS, {
  concurrency: WORKER_CONFIG.concurrency,
  autorun: WORKER_CONFIG.autorun,
})
export class BulkNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(BulkNotificationProcessor.name);

  constructor(
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    @InjectRepository(NotificationCampaign)
    private readonly campaignsRepository: Repository<NotificationCampaign>,
    @InjectQueue(QUEUE_NAMES.PUSH_NOTIFICATIONS)
    private readonly pushQueue: Queue,
  ) {
    super();
  }

  public async process(job: Job<BulkNotificationJob>): Promise<void> {
    if (job.name !== JOB_TYPES.NOTIFICATION.DELIVER_BULK) {
      this.logger.warn(`Unknown job name ${job.name}`);
      return;
    }

    const { dto, adminId, campaignId } = job.data;
    let lastUserId: string | undefined;
    let processed = 0;

    await this.campaignsRepository.update(campaignId, {
      status: NotificationCampaignStatus.PROCESSING,
      started_at: new Date(),
      error_message: null,
    });

    try {
      for (;;) {
        const recipients = await this.recipientQuery(dto, lastUserId)
          .select(['user.id', 'user.preferred_language'])
          .orderBy('user.id', 'ASC')
          .take(RECIPIENT_BATCH_SIZE)
          .getMany();
        if (recipients.length === 0) break;

        const sentAt = new Date();
        const insert = await this.notificationsRepository
          .createQueryBuilder()
          .insert()
          .into(Notification)
          .values(
            recipients.map((recipient) => {
              const arabic = recipient.preferred_language === PreferredLanguage.AR;
              return {
                dedupe_key: `campaign:${campaignId}:user:${recipient.id}`,
                campaign_id: campaignId,
                created_by_user_id: adminId,
                origin: NotificationOrigin.ADMIN_MANUAL,
                source_event: 'admin_broadcast',
                user_id: recipient.id,
                type: NotificationType.CUSTOM,
                title: arabic && dto.title_ar ? dto.title_ar : (dto.title ?? 'Notification'),
                message: arabic && dto.message_ar ? dto.message_ar : dto.message,
                data: { campaign_id: campaignId, href: '/student/notifications' },
                is_read: false,
                sent_at: sentAt,
                sms_sent: false,
                sms_to: null,
                status: NotificationStatus.SENT,
                attempts: 0,
                error_message: null,
                delivered_at: null,
              };
            }),
          )
          .orIgnore()
          .returning(['id'])
          .execute();

        const insertedIds = (insert.identifiers as Array<{ id?: string }>)
          .map((identifier) => identifier.id)
          .filter((id): id is string => typeof id === 'string');
        if (insertedIds.length > 0) {
          await this.pushQueue.addBulk(
            insertedIds.map((notificationId) => ({
              name: JOB_TYPES.PUSH.DELIVER,
              data: { notificationId },
              opts: { jobId: queueJobId('push', notificationId) },
            })),
          );
        }

        processed += recipients.length;
        lastUserId = recipients[recipients.length - 1]?.id;
        await job.updateProgress(processed);
      }

      const createdCount = await this.notificationsRepository.count({
        where: { campaign_id: campaignId },
      });
      const campaign = await this.campaignsRepository.findOneByOrFail({ id: campaignId });
      const failedCount = Math.max(0, campaign.intended_count - createdCount);
      await this.campaignsRepository.update(campaignId, {
        status:
          failedCount === 0
            ? NotificationCampaignStatus.COMPLETED
            : NotificationCampaignStatus.PARTIALLY_FAILED,
        created_count: createdCount,
        failed_count: failedCount,
        completed_at: new Date(),
        error_message:
          failedCount === 0
            ? null
            : `${String(failedCount)} intended recipient(s) were not created`,
      });

      this.logger.log(
        `Notification campaign ${campaignId} created ${String(createdCount)} in-app notification(s) ` +
          `for admin ${adminId}`,
      );
    } catch (error) {
      const createdCount = await this.notificationsRepository.count({
        where: { campaign_id: campaignId },
      });
      const campaign = await this.campaignsRepository.findOneBy({ id: campaignId });
      await this.campaignsRepository.update(campaignId, {
        status:
          createdCount > 0
            ? NotificationCampaignStatus.PARTIALLY_FAILED
            : NotificationCampaignStatus.FAILED,
        created_count: createdCount,
        failed_count: Math.max(0, (campaign?.intended_count ?? processed) - createdCount),
        error_message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        completed_at: new Date(),
      });
      throw error;
    }
  }

  private recipientQuery(dto: BulkNotificationDto, afterUserId?: string) {
    const query = this.usersRepository
      .createQueryBuilder('user')
      .leftJoin('student_profiles', 'profile', 'profile.user_id = user.id')
      .where('user.role = :role', { role: 'student' })
      .andWhere('user.is_active = true')
      .andWhere('user.status = :status', { status: UserStatus.APPROVED })
      .andWhere('user.deleted_at IS NULL');

    if (Array.isArray(dto.filter.student_ids) && dto.filter.student_ids.length > 0) {
      query.andWhere('user.id IN (:...studentIds)', { studentIds: dto.filter.student_ids });
    }
    if (afterUserId !== undefined) {
      query.andWhere('user.id > :afterUserId', { afterUserId });
    }

    return query;
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job<BulkNotificationJob> | undefined, error: Error): void {
    this.logger.error(`Bulk notification job ${job?.id ?? ''} failed: ${error.message}`);
  }
}
