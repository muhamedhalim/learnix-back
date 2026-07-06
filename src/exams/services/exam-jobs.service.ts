import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { Queue } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';

/**
 * Producer for the exam background queues. Centralises how the attempt/grading
 * services enqueue work so the queue names / job options live in one place and
 * reuse the shared queue configuration (retries, backoff, priorities).
 */
@Injectable()
export class ExamJobsService {
  private readonly logger = new Logger(ExamJobsService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.EXAM_AUTO_SUBMIT) private readonly autoSubmitQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EXAM_ANALYTICS) private readonly analyticsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EXAM_AI_GRADING) private readonly aiGradingQueue: Queue,
  ) {}

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
}
