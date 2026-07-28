import { Processor, WorkerHost } from '@nestjs/bullmq';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../queues/queues.constants';
import { MailService, type MailJob } from './mail.service';

/** The only component that performs an outbound MailerSend API call. */
@Processor(QUEUE_NAMES.EMAIL, { concurrency: WORKER_CONFIG.concurrency })
export class MailProcessor extends WorkerHost {
  public constructor(private readonly mail: MailService) {
    super();
  }

  public async process(job: Job<MailJob>): Promise<void> {
    if (job.name !== JOB_TYPES.EMAIL.DELIVER) {
      throw new Error(`Unsupported email job: ${job.name}`);
    }
    await this.mail.deliver(job.data);
  }
}
