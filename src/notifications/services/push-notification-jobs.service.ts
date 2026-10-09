import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { Queue } from 'bullmq';

import { areQueuesEnabled, JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';
import { PushDispatchService } from './push-dispatch.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDeliveryStatus } from '../entities';

/** Payload of a `deliver-push-notification` job. Crosses Redis — keep it JSON. */
export interface PushDeliveryJob {
  notificationId: string;
  retryDeliveryId?: string;
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
    private readonly deliveries: NotificationDeliveryService,
  ) {}

  public async enqueueDelivery(
    notificationId: string,
    options: { forceNewJob?: boolean; retryDeliveryId?: string } = {},
  ): Promise<void> {
    if (!areQueuesEnabled()) {
      try {
        const outcome = await this.dispatcher.dispatch(notificationId);
        if (options.retryDeliveryId) {
          await this.deliveries.record(
            options.retryDeliveryId,
            this.statusForOutcome(outcome.status),
            { provider: 'fcm' },
          );
        }
      } catch (error) {
        if (options.retryDeliveryId) {
          await this.deliveries.record(
            options.retryDeliveryId,
            NotificationDeliveryStatus.FAILED,
            { provider: 'fcm', error: error instanceof Error ? error.message : String(error) },
          );
        }
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
    const jobId = options.forceNewJob
      ? `push:${notificationId}:retry:${Date.now().toString(36)}`
      : `push:${notificationId}`;
    await this.queue.add(JOB_TYPES.PUSH.DELIVER, {
      notificationId,
      ...(options.retryDeliveryId ? { retryDeliveryId: options.retryDeliveryId } : {}),
    } satisfies PushDeliveryJob, {
      jobId,
    });
    this.logger.debug(`Enqueued push for notification ${notificationId}`);
  }

  /**
   * Push for many already-persisted notifications at once (T069). Queues enabled:
   * one `addBulk` with the same deterministic `push:<id>` job ids as
   * {@link enqueueDelivery}. Queues disabled: the same per-id inline dispatch,
   * errors swallowed. The caller is responsible for never calling this before the
   * rows are committed.
   */
  public async enqueueDeliveryMany(notificationIds: string[]): Promise<void> {
    if (notificationIds.length === 0) return;
    if (!areQueuesEnabled()) {
      await Promise.all(notificationIds.map(async (id) => this.enqueueDelivery(id)));
      return;
    }
    await this.queue.addBulk(
      notificationIds.map((notificationId) => ({
        name: JOB_TYPES.PUSH.DELIVER,
        data: { notificationId } satisfies PushDeliveryJob,
        opts: { jobId: `push:${notificationId}` },
      })),
    );
    this.logger.debug(`Enqueued push for ${String(notificationIds.length)} notification(s)`);
  }

  private statusForOutcome(status: Awaited<ReturnType<PushDispatchService['dispatch']>>['status']) {
    switch (status) {
      case 'sent':
      case 'partial':
        return NotificationDeliveryStatus.SENT;
      case 'skipped_preference':
        return NotificationDeliveryStatus.SKIPPED_PREFERENCE;
      case 'no_registered_device':
        return NotificationDeliveryStatus.NO_REGISTERED_DEVICE;
      case 'provider_unavailable':
        return NotificationDeliveryStatus.PROVIDER_UNAVAILABLE;
      default:
        return NotificationDeliveryStatus.FAILED;
    }
  }
}
