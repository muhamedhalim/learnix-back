import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { GamificationService } from '../services/gamification.service';

/**
 * Worker on the `gamification` queue. Currently handles the repeatable
 * streak-reset sweep (see `GameJobsService`); the reset itself is an idempotent
 * bulk UPDATE, so re-running is always safe.
 */
@Processor(QUEUE_NAMES.GAMIFICATION, { concurrency: WORKER_CONFIG.concurrency, autorun: WORKER_CONFIG.autorun })
export class GameSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(GameSweepProcessor.name);

  constructor(private readonly gamification: GamificationService) {
    super();
  }

  public async process(job: Job): Promise<void> {
    if (job.name === JOB_TYPES.GAMIFICATION.STREAK_RESET_SWEEP) {
      const reset = await this.gamification.sweepLapsedStreaks();
      if (reset > 0) this.logger.log(`Streak sweep: reset ${String(reset)} lapsed streak(s)`);
    }
  }
}
