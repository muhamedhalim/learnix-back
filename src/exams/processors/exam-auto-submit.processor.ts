import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { AttemptService } from '../services/attempt.service';

interface AutoSubmitJob {
  attemptId: string;
}

/**
 * Worker that finalises an exam attempt once its server-side deadline elapses.
 * The job is scheduled (delayed) at attempt start; finalisation is idempotent
 * (a no-op if the student already submitted), so this is safe to run always.
 */
@Processor(QUEUE_NAMES.EXAM_AUTO_SUBMIT, { concurrency: WORKER_CONFIG.concurrency })
export class ExamAutoSubmitProcessor extends WorkerHost {
  private readonly logger = new Logger(ExamAutoSubmitProcessor.name);

  constructor(private readonly attemptService: AttemptService) {
    super();
  }

  public async process(job: Job<AutoSubmitJob>): Promise<void> {
    if (job.name !== JOB_TYPES.EXAM.AUTO_SUBMIT) return;
    const summary = await this.attemptService.finalizeExpired(job.data.attemptId);
    this.logger.log(
      summary
        ? `Auto-submitted attempt ${job.data.attemptId} → ${summary.state}`
        : `Auto-submit no-op for attempt ${job.data.attemptId} (already finalised)`,
    );
  }
}
