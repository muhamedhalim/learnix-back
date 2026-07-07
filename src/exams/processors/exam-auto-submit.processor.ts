import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { AttemptService } from '../services/attempt.service';

interface AutoSubmitJob {
  attemptId: string;
}

/**
 * Worker on the `exam-auto-submit` queue. Handles two job names sharing the
 * same queue/config (the sweep is a repeatable safety-net for the primary
 * per-attempt job, not a separate system — see `ExamJobsService.onModuleInit`
 * and `AttemptService.sweepExpiredAttempts`):
 *
 *  - AUTO_SUBMIT: finalises a single attempt once its server-side deadline
 *    elapses. The job is scheduled (delayed) at attempt start; finalisation
 *    is idempotent (a no-op if the student already submitted), so this is
 *    safe to run always.
 *  - AUTO_SUBMIT_SWEEP: repeatable (every minute) — catches any IN_PROGRESS
 *    attempt whose deadline passed without its delayed job firing (e.g. Redis
 *    or the worker was down at the time).
 */
@Processor(QUEUE_NAMES.EXAM_AUTO_SUBMIT, { concurrency: WORKER_CONFIG.concurrency })
export class ExamAutoSubmitProcessor extends WorkerHost {
  private readonly logger = new Logger(ExamAutoSubmitProcessor.name);

  constructor(private readonly attemptService: AttemptService) {
    super();
  }

  public async process(job: Job<AutoSubmitJob>): Promise<void> {
    if (job.name === JOB_TYPES.EXAM.AUTO_SUBMIT) {
      const summary = await this.attemptService.finalizeExpired(job.data.attemptId);
      this.logger.log(
        summary
          ? `Auto-submitted attempt ${job.data.attemptId} → ${summary.state}`
          : `Auto-submit no-op for attempt ${job.data.attemptId} (already finalised)`,
      );
      return;
    }

    if (job.name === JOB_TYPES.EXAM.AUTO_SUBMIT_SWEEP) {
      const { scanned, recovered } = await this.attemptService.sweepExpiredAttempts();
      if (recovered.length > 0) {
        this.logger.log(
          `Sweep: scanned ${String(scanned)} expired IN_PROGRESS attempt(s), recovered ${String(recovered.length)}: ${recovered.join(', ')}`,
        );
      } else {
        this.logger.log(`Sweep: scanned ${String(scanned)} expired IN_PROGRESS attempt(s), nothing to recover`);
      }
    }
  }
}
