import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../../queues/queues.constants';
import { ClearanceSweepService } from '../../jobs/clearance.job';
import { CourseRemovalService, RemovalOrderJobData } from '../course-removal.service';

/**
 * One queue shared with the clearance-sweep and future reconciliation jobs
 * (`QUEUE_NAMES.MARKETPLACE`) — dispatches by job name, matching
 * `MeetingProvisioningProcessor`'s unknown-job-name pattern for the rest.
 * A second job type dispatches through the same worker rather than a
 * second `@Processor(QUEUE_NAMES.MARKETPLACE)` class — BullMQ expects one
 * worker binding per queue. Deliberately thin: `CourseRemovalService` and
 * `ClearanceSweepService` own every decision, so behaviour is identical
 * whether it runs here or is unit-tested directly.
 */
@Processor(QUEUE_NAMES.MARKETPLACE, { concurrency: WORKER_CONFIG.concurrency })
export class MarketplaceRemovalProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketplaceRemovalProcessor.name);

  constructor(
    private readonly removal: CourseRemovalService,
    private readonly clearanceSweep: ClearanceSweepService,
  ) {
    super();
  }

  public async process(job: Job<RemovalOrderJobData>): Promise<void> {
    if (job.name === JOB_TYPES.MARKETPLACE.REMOVAL_ORDER) {
      await this.removal.processRemovalOrder(job.data);
      return;
    }
    if (job.name === JOB_TYPES.MARKETPLACE.CLEARANCE_SWEEP) {
      await this.clearanceSweep.runSweep();
      return;
    }
    this.logger.warn(`Unknown job name ${job.name}`);
  }
}
