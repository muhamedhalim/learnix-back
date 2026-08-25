import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { LessonSessionsService } from '../lesson-sessions.service';

interface MeetingProvisionJob {
  sessionId: string;
}

/**
 * Worker for the explicit per-appointment "Generate Meeting Link" action
 * (Phase 5, AD-7) — one job per teacher click, never per lesson/slot save.
 * Deliberately thin: `LessonSessionsService.provisionMeeting` owns the
 * conditional claim, provider call, and result persistence, so behaviour is
 * identical whether it runs here or is unit-tested directly.
 */
@Processor(QUEUE_NAMES.MEETING_PROVISIONING, { concurrency: WORKER_CONFIG.concurrency })
export class MeetingProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(MeetingProvisioningProcessor.name);

  constructor(private readonly sessions: LessonSessionsService) {
    super();
  }

  public async process(job: Job<MeetingProvisionJob>): Promise<void> {
    if (job.name !== JOB_TYPES.MEETING.PROVISION) {
      this.logger.warn(`Unknown job name ${job.name}`);
      return;
    }
    await this.sessions.provisionMeeting(job.data.sessionId);
  }
}
