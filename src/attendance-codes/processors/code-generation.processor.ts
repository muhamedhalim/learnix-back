import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { QUEUE_NAMES } from '../../queues/queues.constants';
import { CodeBatchesService } from '../code-batches.service';

interface GenerateBatchJob {
  batchId: string;
}

/**
 * BullMQ worker that generates a batch's attendance codes off the request path,
 * reporting progress back to the job. Enables scaling to 100k+ codes without
 * blocking the API. Requires Redis to be configured.
 */
@Processor(QUEUE_NAMES.CODE_GENERATION)
export class CodeGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(CodeGenerationProcessor.name);

  constructor(private readonly codeBatchesService: CodeBatchesService) {
    super();
  }

  public async process(job: Job<GenerateBatchJob>): Promise<void> {
    const { batchId } = job.data;
    this.logger.log(`Processing code-generation job for batch ${batchId}`);
    await this.codeBatchesService.runGeneration(batchId, (percent) => {
      void job.updateProgress(percent);
    });
  }
}
