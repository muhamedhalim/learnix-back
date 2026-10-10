import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { Queue } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';
import { runsBackgroundWork } from '../../config/process-role';

/** Repeatable auto-submit sweep interval — see `AttemptService.sweepExpiredAttempts`. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Producer for the exam background queues. Centralises how the attempt/grading
 * services enqueue work so the queue names / job options live in one place and
 * reuse the shared queue configuration (retries, backoff, priorities).
 */
@Injectable()
export class ExamJobsService implements OnModuleInit {
  private readonly logger = new Logger(ExamJobsService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.EXAM_AUTO_SUBMIT) private readonly autoSubmitQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EXAM_ANALYTICS) private readonly analyticsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EXAM_AI_GRADING) private readonly aiGradingQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EXAM_OMR) private readonly omrQueue: Queue,
  ) {}

  /**
   * Register the repeatable sweep job on boot. BullMQ derives the repeatable
   * job's key from its name + repeat options, so re-registering the same
   * schedule on every app start is idempotent (no duplicate schedules) — this
   * is what makes the sweep self-healing after a Redis restart or worker
   * downtime: the next tick (≤60s after the app is back) picks up anything
   * that was missed, with no manual re-registration step required.
   */
  public async onModuleInit(): Promise<void> {
    // Repeatable schedules are registered by processes that do background work only.
    if (!runsBackgroundWork()) return;
    await this.autoSubmitQueue.add(
      JOB_TYPES.EXAM.AUTO_SUBMIT_SWEEP,
      {},
      { repeat: { every: SWEEP_INTERVAL_MS }, jobId: 'auto-submit-sweep' },
    );
    this.logger.log(`Registered repeatable auto-submit sweep (every ${String(SWEEP_INTERVAL_MS)}ms)`);
  }

  /**
   * Schedule a delayed auto-submit for an attempt. `jobId` is deterministic per
   * attempt so re-scheduling (e.g. on resume) does not create duplicates, and a
   * completed submit leaves the job to no-op.
   */
  public async scheduleAutoSubmit(attemptId: string, delayMs: number): Promise<void> {
    await this.autoSubmitQueue.add(
      JOB_TYPES.EXAM.AUTO_SUBMIT,
      { attemptId },
      { delay: Math.max(0, delayMs), jobId: `autosubmit-${attemptId}` },
    );
    this.logger.log(`Scheduled auto-submit for attempt ${attemptId} in ${String(delayMs)}ms`);
  }

  /** Cancel a pending auto-submit job once an attempt is finalised early. */
  public async cancelAutoSubmit(attemptId: string): Promise<void> {
    const job = await this.autoSubmitQueue.getJob(`autosubmit-${attemptId}`);
    if (job) {
      await job.remove().catch(() => undefined);
    }
  }

  /** Queue an analytics recomputation for an exam after a grade change. */
  public async enqueueAnalytics(examId: string): Promise<void> {
    await this.analyticsQueue.add(JOB_TYPES.EXAM.AGGREGATE_ANALYTICS, { examId });
  }

  /** Queue an AI grading suggestion for a manual answer. */
  public async enqueueAiGrade(answerId: string): Promise<void> {
    await this.aiGradingQueue.add(JOB_TYPES.EXAM.AI_GRADE_ANSWER, { answerId });
  }

  /**
   * Queue processing of a submitted OMR sheet. `jobId` is deterministic per
   * sheet — same idempotent-enqueue convention as `scheduleAutoSubmit` — so a
   * duplicate enqueue (e.g. a retried request) does not create a second job.
   */
  public async enqueueOmrProcessing(sheetId: string): Promise<void> {
    await this.omrQueue.add(JOB_TYPES.EXAM.OMR_PROCESS_SHEET, { sheetId }, { jobId: `omr-${sheetId}` });
    this.logger.log(`Queued OMR processing for sheet ${sheetId}`);
  }
}
