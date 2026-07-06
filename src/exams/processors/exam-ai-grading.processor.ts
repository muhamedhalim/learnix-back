import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { ExamAiGradingService } from '../services/exam-ai-grading.service';

interface AiGradeJob {
  answerId: string;
}

/**
 * Worker that produces an advisory AI-suggested score for one manual answer.
 * Suggestions are written to `ai_suggested_score`/`ai_confidence` only — the
 * teacher always makes the final grading decision.
 */
@Processor(QUEUE_NAMES.EXAM_AI_GRADING, { concurrency: WORKER_CONFIG.concurrency })
export class ExamAiGradingProcessor extends WorkerHost {
  private readonly logger = new Logger(ExamAiGradingProcessor.name);

  constructor(private readonly aiGrading: ExamAiGradingService) {
    super();
  }

  public async process(job: Job<AiGradeJob>): Promise<void> {
    if (job.name !== JOB_TYPES.EXAM.AI_GRADE_ANSWER) return;
    await this.aiGrading.generateSuggestion(job.data.answerId);
    this.logger.log(`Generated AI suggestion for answer ${job.data.answerId}`);
  }
}
