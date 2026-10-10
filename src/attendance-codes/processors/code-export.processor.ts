import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { CodeExportService } from '../code-export.service';

interface ExportJob {
  exportId: string;
}

/**
 * BullMQ worker for attendance-code exports. A single worker handles every
 * format (CSV/Excel/PDF/JSON/QR) plus cache cleanup, dispatching by job name.
 * The heavy file streaming runs here, off the request path. Requires Redis.
 */
@Processor(QUEUE_NAMES.CODE_EXPORT, { autorun: WORKER_CONFIG.autorun })
export class CodeExportProcessor extends WorkerHost {
  private readonly logger = new Logger(CodeExportProcessor.name);

  constructor(private readonly exportService: CodeExportService) {
    super();
  }

  public async process(job: Job<ExportJob>): Promise<unknown> {
    if (job.name === JOB_TYPES.EXPORT.CLEANUP) {
      return await this.exportService.cleanupExpired();
    }

    const { exportId } = job.data;
    this.logger.log(`Processing ${job.name} for export ${exportId}`);
    await this.exportService.runExport(exportId, (percent) => {
      void job.updateProgress(percent);
    });
    return { exportId };
  }
}
