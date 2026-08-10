import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { FEATURE_FLAGS, isFeatureEnabled } from '../../config/feature-flags';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { PushDispatchService } from '../services/push-dispatch.service';
import type { PushDeliveryJob } from '../services/push-notification-jobs.service';

/**
 * The push worker.
 *
 * Deliberately thin: every decision — preference, device selection, invalid
 * token handling, delivery records — belongs to `PushDispatchService`, so the
 * behaviour under test is the same whether it runs here or inline (see
 * `PushNotificationJobsService`).
 *
 * Failure policy: the dispatcher throws only when at least one device leg
 * failed *transiently*. Everything else — preference off, no device, a
 * permanently invalid token — is a completed job with a recorded outcome, not
 * a retry, because no amount of retrying changes any of them.
 */
@Processor(QUEUE_NAMES.PUSH_NOTIFICATIONS, { concurrency: WORKER_CONFIG.concurrency })
export class PushNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(PushNotificationProcessor.name);

  constructor(private readonly dispatcher: PushDispatchService) {
    super();
  }

  public async process(job: Job<PushDeliveryJob>): Promise<void> {
    // CONTACTS REAL DEVICES. Same gate the guardian worker uses, for the same
    // reason: an environment that has switched delivery off must park work
    // rather than send it, and must not accumulate failed jobs while doing so.
    if (!isFeatureEnabled(FEATURE_FLAGS.NOTIFICATIONS)) {
      this.logger.log(`Push ${job.name} skipped: ENABLE_NOTIFICATIONS=false.`);
      return;
    }

    if (job.name !== JOB_TYPES.PUSH.DELIVER) {
      this.logger.warn(`Unknown job name ${job.name}`);
      return;
    }

    await this.dispatcher.dispatch(job.data.notificationId, job.attemptsMade + 1);
  }
}
