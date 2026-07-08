import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { Queue } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';

/** Nightly sweep cadence (ms). Runs hourly so a lapsed streak clears promptly. */
const STREAK_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Producer for gamification background jobs. Registers the repeatable
 * streak-reset sweep on boot. BullMQ derives a repeatable job's key from its
 * name + repeat options, so re-registering on every start is idempotent (no
 * duplicate schedules) and self-healing after a Redis/worker restart — the same
 * pattern as the exam auto-submit sweep.
 */
@Injectable()
export class GameJobsService implements OnModuleInit {
  private readonly logger = new Logger(GameJobsService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.GAMIFICATION) private readonly queue: Queue,
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.queue.add(
      JOB_TYPES.GAMIFICATION.STREAK_RESET_SWEEP,
      {},
      { repeat: { every: STREAK_SWEEP_INTERVAL_MS }, jobId: 'streak-reset-sweep' },
    );
    this.logger.log(`Registered repeatable streak-reset sweep (every ${String(STREAK_SWEEP_INTERVAL_MS)}ms)`);
  }
}
