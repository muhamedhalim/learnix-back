import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Job } from 'bullmq';
import { Repository } from 'typeorm';

import { Notification, NotificationStatus, NotificationType } from '../../notifications/entities';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { User } from '../../users/entities/user.entity';
import type { BulkNotificationDto } from '../dto';

interface BulkNotificationJob {
  dto: BulkNotificationDto;
  adminId: string;
}

const RECIPIENT_BATCH_SIZE = 500;

@Processor(QUEUE_NAMES.BULK_NOTIFICATIONS, { concurrency: WORKER_CONFIG.concurrency })
export class BulkNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(BulkNotificationProcessor.name);

  constructor(
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
  ) {
    super();
  }

  public async process(job: Job<BulkNotificationJob>): Promise<void> {
    if (job.name !== JOB_TYPES.NOTIFICATION.DELIVER_BULK) {
      this.logger.warn(`Unknown job name ${job.name}`);
      return;
    }

    const { dto, adminId } = job.data;
    let lastUserId: string | undefined;
    let delivered = 0;

    for (;;) {
      const recipients = await this.recipientQuery(dto, lastUserId)
        .select(['user.id'])
        .orderBy('user.id', 'ASC')
        .take(RECIPIENT_BATCH_SIZE)
        .getMany();
      if (recipients.length === 0) break;

      const sentAt = new Date();
      await this.notificationsRepository
        .createQueryBuilder()
        .insert()
        .into(Notification)
        .values(
          recipients.map((recipient) => ({
            user_id: recipient.id,
            type: NotificationType.CUSTOM,
            title: dto.title ?? 'Notification',
            message: dto.message,
            data: null,
            is_read: false,
            sent_at: sentAt,
            sms_sent: false,
            sms_to: null,
            status: NotificationStatus.PENDING,
            attempts: 0,
            error_message: null,
            delivered_at: null,
          })),
        )
        .execute();

      delivered += recipients.length;
      lastUserId = recipients[recipients.length - 1]?.id;
      await job.updateProgress(delivered);
    }

    this.logger.log(
      `Bulk notification job ${job.id ?? ''} delivered to ${delivered} students for admin ${adminId}`,
    );
  }

  private recipientQuery(dto: BulkNotificationDto, afterUserId?: string) {
    const query = this.usersRepository
      .createQueryBuilder('user')
      .leftJoin('student_profiles', 'profile', 'profile.user_id = user.id')
      .where('user.role = :role', { role: 'student' })
      .andWhere('user.is_active = true')
      .andWhere('user.deleted_at IS NULL');

    if (typeof dto.filter.grade_level === 'string' && dto.filter.grade_level !== '') {
      query.andWhere('profile.grade_level = :gradeLevel', { gradeLevel: dto.filter.grade_level });
    }
    if (typeof dto.filter.status === 'string' && dto.filter.status !== 'all') {
      query.andWhere('user.is_active = :isActive', { isActive: dto.filter.status === 'active' });
    }
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
