import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { Queue } from 'bullmq';

import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';
import { queueJobId } from '../../queues/job-id.util';
import { ParentReportType } from '../entities/parent-report-type.enum';
import {
  MONTHLY_SWEEP_CRON,
  REPORT_TIME_ZONE,
  WEEKLY_SWEEP_CRON,
} from '../parent-report.constants';

/** Payload of a `build-parent-report` job. Crosses Redis — keep it JSON. */
export interface BuildReportJob {
  studentId: string;
  reportType: ParentReportType;
  /** ISO instant the sweep resolved its period from — see below. */
  resolvedAt: string;
}

/**
 * The only thing allowed to put report work on a queue, and the registrar of
 * the two repeatable sweeps.
 *
 * `resolvedAt` is carried in every BUILD job rather than the period boundaries
 * themselves, and the worker re-derives the period from it. That looks like
 * indirection but is the point: period resolution stays in exactly one pure
 * function, so a job that sat in Redis across a restart, a retry, or a
 * deployment cannot come back referring to boundaries computed by an older
 * version of the rule. It also keeps the job payload immune to the timezone
 * config changing underneath it mid-sweep.
 */
@Injectable()
export class ParentReportJobsService implements OnModuleInit {
  private readonly logger = new Logger(ParentReportJobsService.name);

  constructor(@InjectQueue(QUEUE_NAMES.PARENT_REPORTS) private readonly queue: Queue) {}

  /**
   * Register both sweeps on boot.
   *
   * BullMQ derives a repeatable job's key from its name plus repeat options, so
   * re-registering on every start is idempotent — no duplicate schedules — and
   * self-healing after a Redis flush or a worker restart. Same pattern as the
   * exam auto-submit and gamification streak sweeps.
   */
  public async onModuleInit(): Promise<void> {
    await this.queue.add(
      JOB_TYPES.PARENT_REPORT.SWEEP_WEEKLY,
      {},
      {
        repeat: { pattern: WEEKLY_SWEEP_CRON, tz: REPORT_TIME_ZONE },
        jobId: 'parent-report-weekly-sweep',
      },
    );
    await this.queue.add(
      JOB_TYPES.PARENT_REPORT.SWEEP_MONTHLY,
      {},
      {
        repeat: { pattern: MONTHLY_SWEEP_CRON, tz: REPORT_TIME_ZONE },
        jobId: 'parent-report-monthly-sweep',
      },
    );

    this.logger.log(
      `Registered parent-report sweeps — weekly "${WEEKLY_SWEEP_CRON}", ` +
        `monthly "${MONTHLY_SWEEP_CRON}" (${REPORT_TIME_ZONE})`,
    );
  }

  /**
   * Enqueue one student's report build.
   *
   * The job id is deterministic per (type, student, period), so a sweep that
   * runs twice — or two sweeps racing after a restart — enqueues once. This is
   * belt-and-braces over the real guarantee, which is the unique constraint on
   * `parent_reports`: BullMQ forgets completed job ids after `removeOnComplete`,
   * Postgres does not forget.
   */
  public async enqueueBuild(job: BuildReportJob, periodKey: string): Promise<void> {
    await this.queue.add(JOB_TYPES.PARENT_REPORT.BUILD, job, {
      jobId: queueJobId('parent-report', job.reportType, job.studentId, periodKey),
    });
  }

  /** Bulk enqueue for one sweep page — one Redis round trip instead of N. */
  public async enqueueBuildBatch(
    jobs: readonly BuildReportJob[],
    periodKey: string,
  ): Promise<void> {
    if (jobs.length === 0) return;

    await this.queue.addBulk(
      jobs.map((job) => ({
        name: JOB_TYPES.PARENT_REPORT.BUILD,
        data: job,
        opts: {
          jobId: queueJobId('parent-report', job.reportType, job.studentId, periodKey),
        },
      })),
    );
  }
}
