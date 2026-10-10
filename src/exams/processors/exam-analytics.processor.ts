import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { AnalyticsService } from '../../analytics/analytics.service';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';

interface AnalyticsJob {
  examId: string;
}

/**
 * Worker that recomputes + warms an exam's aggregated analytics after any grade
 * change, so teacher dashboards read fresh, precomputed stats off the hot path.
 */
@Processor(QUEUE_NAMES.EXAM_ANALYTICS, { concurrency: WORKER_CONFIG.concurrency, autorun: WORKER_CONFIG.autorun })
export class ExamAnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger(ExamAnalyticsProcessor.name);

  constructor(private readonly analytics: AnalyticsService) {
    super();
  }

  public async process(job: Job<AnalyticsJob>): Promise<void> {
    if (job.name !== JOB_TYPES.EXAM.AGGREGATE_ANALYTICS) return;
    await this.analytics.recomputeExam(job.data.examId);
    this.logger.log(`Recomputed analytics for exam ${job.data.examId}`);
  }
}
