import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';

import { Job } from 'bullmq';
import { Repository } from 'typeorm';

import { NotificationDelivery, NotificationDeliveryStatus } from '../notifications/entities';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../queues/queues.constants';
import { MailService, type MailJob } from './mail.service';

/** The only component that performs an outbound email API call (Amazon SES). */
@Processor(QUEUE_NAMES.EMAIL, {
  concurrency: WORKER_CONFIG.concurrency,
  autorun: WORKER_CONFIG.autorun,
})
export class MailProcessor extends WorkerHost {
  public constructor(
    private readonly mail: MailService,
    @InjectRepository(NotificationDelivery)
    private readonly deliveries: Repository<NotificationDelivery>,
  ) {
    super();
  }

  public async process(job: Job<MailJob>): Promise<void> {
    if (job.name !== JOB_TYPES.EMAIL.DELIVER) {
      throw new Error(`Unsupported email job: ${job.name}`);
    }
    try {
      const result = await this.mail.deliver(job.data);
      if (job.data.notificationDeliveryId !== undefined) {
        await this.deliveries.update(job.data.notificationDeliveryId, {
          status: result.accepted
            ? NotificationDeliveryStatus.SENT
            : NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
          provider: this.mail.providerName,
          provider_message_id: result.providerMessageId ?? null,
          error_message: result.reason?.slice(0, 1000) ?? null,
          attempts: job.attemptsMade + 1,
          sent_at: result.accepted ? new Date() : null,
        });
      }
    } catch (error) {
      if (job.data.notificationDeliveryId !== undefined) {
        await this.deliveries.update(job.data.notificationDeliveryId, {
          status: NotificationDeliveryStatus.FAILED,
          provider: this.mail.providerName,
          error_message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          attempts: job.attemptsMade + 1,
        });
      }
      throw error;
    }
  }
}
