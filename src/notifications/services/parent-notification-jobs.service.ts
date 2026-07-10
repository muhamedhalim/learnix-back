import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { Queue } from 'bullmq';

import type { ParentEventType } from '../../common/events/parent-event-type.enum';
import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';

/** Payload of a `deliver-parent-message` job. Crosses Redis — keep it JSON. */
export interface ParentDeliveryJob {
  eventType: ParentEventType;
  studentId: string;
  subjectId: string;
  variables: Record<string, unknown>;
}

/** Payload of a `redeliver-parent-message` job (admin-triggered retry). */
export interface ParentRedeliveryJob {
  parentMessageId: string;
}

/**
 * The only thing allowed to put guardian work on a queue.
 *
 * Centralising `add()` keeps job names, dedup ids and queue selection in one
 * place, mirroring the existing `ExamJobsService`.
 */
@Injectable()
export class ParentNotificationJobsService {
  private readonly logger = new Logger(ParentNotificationJobsService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.PARENT_NOTIFICATIONS) private readonly queue: Queue,
    @InjectQueue(QUEUE_NAMES.PARENT_NOTIFICATIONS_DLQ) private readonly dlq: Queue,
  ) {}

  /**
   * `jobId` is deterministic per (event, subject) so a domain service that
   * emits twice — a retried HTTP request, an at-least-once outbox — enqueues
   * once. This is belt-and-braces on top of the DB-level idempotency key, which
   * is the real guarantee: BullMQ forgets completed job ids after `removeOnComplete`.
   */
  public async enqueueDelivery(
    job: ParentDeliveryJob,
    options: { bypassDedup?: boolean } = {},
  ): Promise<void> {
    // A human-initiated retry must not be swallowed by the dedup id: BullMQ
    // rejects an `add()` whose jobId still exists (completed jobs linger for
    // `removeOnComplete.age`). The DB idempotency key still protects against
    // an actual double-send.
    const jobId =
      options.bypassDedup === true
        ? `parent:${job.eventType}:${job.subjectId}:retry:${String(Date.now())}`
        : `parent:${job.eventType}:${job.subjectId}`;

    await this.queue.add(JOB_TYPES.PARENT.DELIVER, job, { jobId });
    this.logger.debug(`Enqueued ${job.eventType} for student ${job.studentId}`);
  }

  /** Admin "retry" on a failed/dead message. */
  public async enqueueRedelivery(parentMessageId: string): Promise<void> {
    await this.queue.add(
      JOB_TYPES.PARENT.REDELIVER,
      { parentMessageId } satisfies ParentRedeliveryJob,
      { jobId: `parent:redeliver:${parentMessageId}:${String(Date.now())}` },
    );
  }

  /**
   * Park an exhausted job. Nothing consumes the DLQ; it exists so a permanently
   * failed guardian message is visible in Bull Board and replayable, instead of
   * disappearing when BullMQ trims the failed set.
   */
  public async deadLetter(job: ParentDeliveryJob, reason: string): Promise<void> {
    await this.dlq.add(JOB_TYPES.PARENT.DELIVER, { ...job, reason });
    this.logger.error(
      `Dead-lettered ${job.eventType} for student ${job.studentId} (subject ${job.subjectId}): ${reason}`,
    );
  }
}
