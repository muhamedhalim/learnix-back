import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { DelayedError, Job } from 'bullmq';

import { FEATURE_FLAGS, isFeatureEnabled } from '../../config/feature-flags';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { PushDispatchService } from '../services/push-dispatch.service';
import { NotificationDeliveryService } from '../services/notification-delivery.service';
import { NotificationDeliveryStatus } from '../entities';
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

  constructor(
    private readonly dispatcher: PushDispatchService,
    private readonly deliveries: NotificationDeliveryService,
  ) {
    super();
  }

  public async process(job: Job<PushDeliveryJob>): Promise<void> {
    // CONTACTS REAL DEVICES. Same gate the guardian worker uses, for the same
    // reason: an environment that has switched delivery off must park work
    // rather than send it, and must not accumulate failed jobs while doing so.
    if (!isFeatureEnabled(FEATURE_FLAGS.NOTIFICATIONS)) {
      await job.moveToDelayed(Date.now() + 5 * 60_000, job.token);
      this.logger.log(`Push ${job.name} parked: ENABLE_NOTIFICATIONS=false.`);
      throw new DelayedError();
    }

    if (job.name !== JOB_TYPES.PUSH.DELIVER) {
      this.logger.warn(`Unknown job name ${job.name}`);
      return;
    }

    try {
      const outcome = await this.dispatcher.dispatch(
        job.data.notificationId,
        job.attemptsMade + 1,
      );
      if (job.data.retryDeliveryId) {
        const status =
          outcome.status === 'sent' || outcome.status === 'partial'
            ? NotificationDeliveryStatus.SENT
            : outcome.status === 'skipped_preference'
              ? NotificationDeliveryStatus.SKIPPED_PREFERENCE
              : outcome.status === 'no_registered_device'
                ? NotificationDeliveryStatus.NO_REGISTERED_DEVICE
                : outcome.status === 'provider_unavailable'
                  ? NotificationDeliveryStatus.PROVIDER_UNAVAILABLE
                  : NotificationDeliveryStatus.FAILED;
        await this.deliveries.record(job.data.retryDeliveryId, status, {
          provider: 'fcm',
          attempt: job.attemptsMade + 1,
        });
      }
    } catch (error) {
      if (job.data.retryDeliveryId) {
        await this.deliveries.record(
          job.data.retryDeliveryId,
          NotificationDeliveryStatus.FAILED,
          {
            provider: 'fcm',
            attempt: job.attemptsMade + 1,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      throw error;
    }
  }
}
