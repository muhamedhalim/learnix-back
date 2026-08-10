import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';

import { FEATURE_FLAGS, isFeatureEnabled } from '../../config/feature-flags';
import { GuardiansService } from '../../guardians/guardians.service';
import { ParentNotificationJobsService } from '../../notifications/services/parent-notification-jobs.service';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { User } from '../../users/entities/user.entity';
import { ParentReportStatus } from '../entities/parent-report-status.enum';
import { reportEventType, ParentReportType } from '../entities/parent-report-type.enum';
import {
  isWithinCatchUpWindow,
  resolveReportPeriod,
  type ReportPeriod,
} from '../logic/report-period';
import {
  CATCH_UP_WINDOW_DAYS,
  REPORT_TIME_ZONE,
  SEND_EMPTY_REPORTS,
  SWEEP_PAGE_SIZE,
} from '../parent-report.constants';
import { ParentReportAggregatorService } from '../services/parent-report-aggregator.service';
import { ParentReportService } from '../services/parent-report.service';
import {
  ParentReportJobsService,
  type BuildReportJob,
} from '../services/parent-report-jobs.service';

/**
 * The report engine's worker.
 *
 * Two job shapes, one pipeline:
 *
 *   sweep (1 per type per day)
 *     → page through students with an eligible guardian
 *     → BUILD job per student
 *   build (1 per student per period)
 *     → claim the period      (unique constraint = idempotency)
 *     → aggregate             (counts only, no prose, no provider)
 *     → enqueue a ParentNotification
 *
 * Note where this stops. The report engine never renders a message, never picks
 * a channel, and never touches WhatsApp, SMS, Firebase or Meta. It hands a
 * typed payload to `ParentNotificationJobsService` and the DEF-005 dispatcher
 * takes over — the same path an exam result travels. That boundary is what
 * keeps "which provider is configured" entirely outside the aggregator, and it
 * is why a deployment with no WhatsApp still delivers reports over SMS.
 *
 * Failure isolation is structural rather than defensive: one student is one
 * job, so a student whose aggregation throws fails their own job and no one
 * else's. The sweep only enqueues.
 */
@Processor(QUEUE_NAMES.PARENT_REPORTS, { concurrency: WORKER_CONFIG.concurrency })
export class ParentReportProcessor extends WorkerHost {
  private readonly logger = new Logger(ParentReportProcessor.name);

  constructor(
    private readonly guardians: GuardiansService,
    private readonly aggregator: ParentReportAggregatorService,
    private readonly reports: ParentReportService,
    private readonly jobs: ParentReportJobsService,
    private readonly notifications: ParentNotificationJobsService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {
    super();
  }

  public async process(job: Job): Promise<void> {
    // Reports end up contacting real people. Gate at the single entry point,
    // matching ParentNotificationProcessor. Returning rather than throwing
    // marks the job completed: a deployment that deliberately switched
    // notifications off should not accumulate a month of failed sweeps.
    if (!isFeatureEnabled(FEATURE_FLAGS.NOTIFICATIONS)) {
      this.logger.log(`Parent report ${job.name} skipped: ENABLE_NOTIFICATIONS=false.`);
      return;
    }

    switch (job.name) {
      case JOB_TYPES.PARENT_REPORT.SWEEP_WEEKLY:
        await this.sweep(ParentReportType.WEEKLY);
        return;
      case JOB_TYPES.PARENT_REPORT.SWEEP_MONTHLY:
        await this.sweep(ParentReportType.MONTHLY);
        return;
      case JOB_TYPES.PARENT_REPORT.BUILD:
        await this.build(job as Job<BuildReportJob>);
        return;
      default:
        this.logger.warn(`Unknown job name ${job.name}`);
    }
  }

  /**
   * Fan one period out across the platform, a page at a time.
   *
   * Never materialises the full student list: `findStudentsWithEligibleGuardians`
   * is keyset-paginated, so peak memory is one page of uuids whether the
   * platform has 50 students or 500,000.
   */
  private async sweep(reportType: ParentReportType): Promise<void> {
    const now = new Date();
    const period = resolveReportPeriod(reportType, now, REPORT_TIME_ZONE);

    // The sweep runs daily so a missed run self-heals; on every other day of
    // the window the period has already been reported and this is where we
    // stop, before touching the database at all.
    if (!isWithinCatchUpWindow(period, now, CATCH_UP_WINDOW_DAYS)) {
      this.logger.debug(
        `${reportType} period ${period.key} closed more than ${String(CATCH_UP_WINDOW_DAYS)} ` +
          `day(s) ago — nothing to sweep`,
      );
      return;
    }

    const eventType = reportEventType(reportType);
    let cursor: string | undefined;
    let enqueued = 0;

    for (;;) {
      const studentIds = await this.guardians.findStudentsWithEligibleGuardians(eventType, {
        afterStudentId: cursor,
        limit: SWEEP_PAGE_SIZE,
      });
      if (studentIds.length === 0) break;

      await this.jobs.enqueueBuildBatch(
        studentIds.map(
          (studentId): BuildReportJob => ({
            studentId,
            reportType,
            resolvedAt: now.toISOString(),
          }),
        ),
        period.key,
      );

      enqueued += studentIds.length;
      cursor = studentIds[studentIds.length - 1];

      // A short page means the last page.
      if (studentIds.length < SWEEP_PAGE_SIZE) break;
    }

    this.logger.log(
      `${reportType} sweep for ${period.key} (${period.startDate}…${period.endDate}, ` +
        `${period.timeZone}): enqueued ${String(enqueued)} student report(s)`,
    );
  }

  /** Aggregate and dispatch one student's report for one period. */
  private async build(job: Job<BuildReportJob>): Promise<void> {
    const { studentId, reportType, resolvedAt } = job.data;

    const resolvedInstant = new Date(resolvedAt);
    if (Number.isNaN(resolvedInstant.getTime())) {
      // A malformed payload will be malformed on every retry.
      throw new UnrecoverableError(`Invalid resolvedAt "${resolvedAt}"`);
    }

    // Re-derive rather than trust: period rules live in exactly one place, and
    // a job that waited in Redis across a deployment must use today's rule.
    const period = resolveReportPeriod(reportType, resolvedInstant, REPORT_TIME_ZONE);

    const claim = await this.reports.claim(studentId, period);
    if (!claim.claimed) {
      this.logger.debug(
        `Report ${reportType}/${period.key} for student ${studentId} already ` +
          `${claim.report.status} — nothing to do`,
      );
      return;
    }

    const report = claim.report;

    // Re-check eligibility at build time. The sweep's candidate list can be
    // minutes or hours old; a guardian who switched the toggle off in between
    // must not receive this report. `findNotificationTargets` is the canonical
    // authority — the same one the notification worker will consult again.
    const eventType = reportEventType(reportType);
    const targets = await this.guardians.findNotificationTargets(studentId, eventType);
    if (targets.length === 0) {
      await this.reports.markSkipped(report.id, 'No eligible guardian at build time');
      this.logger.debug(`No eligible guardian for ${eventType} / student ${studentId}`);
      return;
    }

    let payload;
    try {
      payload = await this.aggregator.aggregate(studentId, period);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Record the failure, then rethrow so BullMQ retries this student only.
      // The row stays re-claimable (FAILED is not terminal), so the retry — or
      // tomorrow's sweep, within the catch-up window — picks it back up.
      await this.reports.markFailed(report.id, message);
      throw error;
    }

    await this.reports.markGenerated(report.id, payload);

    if (!payload.hasActivity && !SEND_EMPTY_REPORTS) {
      await this.reports.markSkipped(report.id, 'No activity in period');
      this.logger.debug(`${reportType} report for student ${studentId} is empty — suppressed`);
      return;
    }

    const studentName = await this.resolveStudentName(studentId);

    // Hand off to the DEF-005 pipeline. `subjectId` carries the student and the
    // period, which is what makes the resulting `parent_messages` key
    // `<event>:<student>:<period>:<guardian>` — the required idempotency
    // identity. Student must be in there: a guardian with two children would
    // otherwise collide on one key per period and only one child's report
    // would ever be sent.
    await this.notifications.enqueueDelivery({
      eventType,
      studentId,
      subjectId: `${studentId}:${period.key}`,
      variables: {
        studentName,
        periodType: reportType,
        periodStart: period.startDate,
        periodEnd: period.endDate,
        timeZone: period.timeZone,
        report: payload,
      },
    });

    await this.reports.markDispatched(report.id, targets.length);

    this.logger.log(
      `${reportType} report ${period.key} for student ${studentId} dispatched to ` +
        `${String(targets.length)} guardian(s)`,
    );
  }

  private async resolveStudentName(studentId: string): Promise<string> {
    const student = await this.users.findOne({
      where: { id: studentId },
      select: { id: true, name: true },
    });
    return student?.name ?? '';
  }
}

/** Re-exported so tests can assert on states without reaching into entities. */
export { ParentReportStatus };
export type { ReportPeriod };
