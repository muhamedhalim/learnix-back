import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { Queue } from 'bullmq';

import { areQueuesEnabled, JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';
import { PushDispatchService } from './push-dispatch.service';

/** Payload of a `deliver-push-notification` job. Crosses Redis — keep it JSON. */
export interface PushDeliveryJob {
  notificationId: string;
}

/**
 * The only thing allowed to put push work on a queue.
 *
 * Mirrors `ParentNotificationJobsService`: one place that knows job names, queue
 * selection and dedup ids.
 *
 * WHY THE INLINE FALLBACK. When Redis is unconfigured, `registerQueues`
 * substitutes a `NoopQueue` under the same DI token — jobs are accepted and
 * silently dropped. That is the right behaviour for image resizing; it is the
 * wrong behaviour for a channel whose entire defect report was "the toggle does
 * not affect delivery", because it would reintroduce a configuration in which
 * enabling push provably does nothing. So when queues are disabled we dispatch
 * inline instead, on the same code path, and swallow the error: a failed push
 * must never roll back the domain action that produced the notification.
 */
@Injectable()
export class PushNotificationJobsService {
  private readonly logger = new Logger(PushNotificationJobsService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.PUSH_NOTIFICATIONS) private readonly queue: Queue,
    private readonly dispatcher: PushDispatchService,
  ) {}

  public async enqueueDelivery(notificationId: string): Promise<void> {
    if (!areQueuesEnabled()) {
      try {
        await this.dispatcher.dispatch(notificationId);
      } catch (error) {
        this.logger.warn(
          `Inline push dispatch failed for notification ${notificationId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      return;
    }

    // Deterministic job id: a domain service that emits the same notification
    // twice enqueues once. Belt-and-braces on top of the per-device
    // `notification_deliveries` claim, which is the real guarantee.
    await this.queue.add(JOB_TYPES.PUSH.DELIVER, { notificationId } satisfies PushDeliveryJob, {
      jobId: `push:${notificationId}`,
    });
    this.logger.debug(`Enqueued push for notification ${notificationId}`);
  }
}
