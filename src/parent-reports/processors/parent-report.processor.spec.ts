import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { Job, UnrecoverableError } from 'bullmq';

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { PreferredLanguage } from '../../guardians/entities';
import { GuardiansService } from '../../guardians/guardians.service';
import { ParentNotificationJobsService } from '../../notifications/services/parent-notification-jobs.service';
import { JOB_TYPES } from '../../queues/queues.constants';
import { User } from '../../users/entities/user.entity';
import { emptyReportPayload } from '../entities/parent-report-payload';
import { ParentReportStatus } from '../entities/parent-report-status.enum';
import { ParentReportType } from '../entities/parent-report-type.enum';
import { SWEEP_PAGE_SIZE } from '../parent-report.constants';
import { ParentReportAggregatorService } from '../services/parent-report-aggregator.service';
import { ParentReportService } from '../services/parent-report.service';
import { ParentReportJobsService } from '../services/parent-report-jobs.service';
import { ParentReportProcessor } from './parent-report.processor';

const TARGET = {
  guardian_id: 'g1',
  student_id: 's1',
  phone_e164: '+201012345678',
  full_name: 'Parent',
  preferred_language: PreferredLanguage.AR,
  whatsapp_capable: true,
};

/** A Monday — the last complete week is 3–9 August 2026 (`w2026-08-03`). */
const MONDAY = '2026-08-10T06:00:00.000Z';

function activityPayload(): ReturnType<typeof emptyReportPayload> {
  return {
    ...emptyReportPayload(),
    study: { sessions: 4, lessons: 3, minutes: 95, completed: 1 },
    hasActivity: true,
  };
}

function sweepJob(name: string): Job {
  return { name, data: {}, opts: {} } as unknown as Job;
}

function buildJob(overrides: Record<string, unknown> = {}): Job {
  return {
    name: JOB_TYPES.PARENT_REPORT.BUILD,
    data: {
      studentId: 's1',
      reportType: ParentReportType.WEEKLY,
      resolvedAt: MONDAY,
      ...overrides,
    },
    opts: { attempts: 3 },
  } as unknown as Job;
}

describe('ParentReportProcessor', () => {
  let processor: ParentReportProcessor;
  let guardians: {
    findNotificationTargets: jest.Mock;
    findStudentsWithEligibleGuardians: jest.Mock;
  };
  let aggregator: { aggregate: jest.Mock };
  let reports: {
    claim: jest.Mock;
    markGenerated: jest.Mock;
    markDispatched: jest.Mock;
    markSkipped: jest.Mock;
    markFailed: jest.Mock;
  };
  let jobs: { enqueueBuildBatch: jest.Mock; enqueueBuild: jest.Mock };
  let notifications: { enqueueDelivery: jest.Mock };

  beforeEach(async () => {
    guardians = {
      findNotificationTargets: jest.fn(async () => [TARGET]),
      findStudentsWithEligibleGuardians: jest.fn(async () => []),
    };
    aggregator = { aggregate: jest.fn(async () => activityPayload()) };
    reports = {
      claim: jest.fn(async () => ({
        claimed: true,
        report: { id: 'r1', status: ParentReportStatus.PENDING },
      })),
      markGenerated: jest.fn(),
      markDispatched: jest.fn(),
      markSkipped: jest.fn(),
      markFailed: jest.fn(),
    };
    jobs = { enqueueBuildBatch: jest.fn(), enqueueBuild: jest.fn() };
    notifications = { enqueueDelivery: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParentReportProcessor,
        { provide: GuardiansService, useValue: guardians },
        { provide: ParentReportAggregatorService, useValue: aggregator },
        { provide: ParentReportService, useValue: reports },
        { provide: ParentReportJobsService, useValue: jobs },
        { provide: ParentNotificationJobsService, useValue: notifications },
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn(async () => ({ id: 's1', name: 'Ahmed' })) },
        },
      ],
    }).compile();

    processor = module.get(ParentReportProcessor);
  });

  describe('sweep', () => {
    // A sweep reads the wall clock to resolve its period, so every test here
    // pins it. Without this the suite would pass or fail depending on which
    // day of the week it happened to run — the catch-up window closes a few
    // days after each period ends.
    afterEach(() => {
      jest.useRealTimers();
    });

    /** Monday 2026-08-10 — one day after the week 3–9 August closed. */
    function atMondayAfterWeekClose(): void {
      jest.useFakeTimers().setSystemTime(new Date(MONDAY));
    }

    it('enqueues a build job per eligible student (weekly ON)', async () => {
      atMondayAfterWeekClose();
      guardians.findStudentsWithEligibleGuardians.mockResolvedValueOnce(['s1', 's2']);

      await processor.process(sweepJob(JOB_TYPES.PARENT_REPORT.SWEEP_WEEKLY));

      expect(guardians.findStudentsWithEligibleGuardians).toHaveBeenCalledWith(
        ParentEventType.WEEKLY_REPORT,
        expect.objectContaining({ limit: SWEEP_PAGE_SIZE }),
      );
      expect(jobs.enqueueBuildBatch).toHaveBeenCalledTimes(1);

      const [batch, periodKey] = jobs.enqueueBuildBatch.mock.calls[0] as [
        { studentId: string; reportType: ParentReportType }[],
        string,
      ];
      expect(batch.map((job) => job.studentId)).toEqual(['s1', 's2']);
      expect(batch.every((job) => job.reportType === ParentReportType.WEEKLY)).toBe(true);
      expect(periodKey).toMatch(/^w\d{4}-\d{2}-\d{2}$/);
    });

    it('enqueues nothing when no guardian has the weekly toggle on (weekly OFF)', async () => {
      atMondayAfterWeekClose();
      guardians.findStudentsWithEligibleGuardians.mockResolvedValue([]);

      await processor.process(sweepJob(JOB_TYPES.PARENT_REPORT.SWEEP_WEEKLY));

      expect(jobs.enqueueBuildBatch).not.toHaveBeenCalled();
    });

    it('queries the monthly preference for the monthly sweep', async () => {
      // The 1st — the only few days of the month when July's report is due.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-01T06:00:00.000Z'));
      guardians.findStudentsWithEligibleGuardians.mockResolvedValueOnce(['s1']);

      await processor.process(sweepJob(JOB_TYPES.PARENT_REPORT.SWEEP_MONTHLY));

      expect(guardians.findStudentsWithEligibleGuardians).toHaveBeenCalledWith(
        ParentEventType.MONTHLY_REPORT,
        expect.anything(),
      );
      const [, periodKey] = jobs.enqueueBuildBatch.mock.calls[0] as [unknown, string];
      expect(periodKey).toMatch(/^m\d{4}-\d{2}$/);
    });

    it('pages with a keyset cursor rather than loading every student', async () => {
      atMondayAfterWeekClose();
      const fullPage = Array.from({ length: SWEEP_PAGE_SIZE }, (_, i) => `s${String(i)}`);
      guardians.findStudentsWithEligibleGuardians
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce(['tail']);

      await processor.process(sweepJob(JOB_TYPES.PARENT_REPORT.SWEEP_WEEKLY));

      expect(guardians.findStudentsWithEligibleGuardians).toHaveBeenCalledTimes(2);
      // Second page must resume after the last id of the first.
      expect(guardians.findStudentsWithEligibleGuardians.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ afterStudentId: fullPage[fullPage.length - 1] }),
      );
      expect(jobs.enqueueBuildBatch).toHaveBeenCalledTimes(2);
    });

    it('stops without touching the database once the catch-up window has closed', async () => {
      // Friday 2026-08-28. The last complete week (17–23 Aug) closed at local
      // midnight on the 24th — four days earlier, past the 3-day window. This
      // is what makes running the sweep DAILY safe: on every day but the first
      // few it does nothing at all, rather than re-attempting a sent report.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-28T06:00:00.000Z'));

      await processor.process(sweepJob(JOB_TYPES.PARENT_REPORT.SWEEP_WEEKLY));

      expect(guardians.findStudentsWithEligibleGuardians).not.toHaveBeenCalled();
      expect(jobs.enqueueBuildBatch).not.toHaveBeenCalled();
    });

    it('still sweeps two days late, so a missed run self-heals', async () => {
      // Wednesday — the worker was down on Monday and Tuesday.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T06:00:00.000Z'));
      guardians.findStudentsWithEligibleGuardians.mockResolvedValueOnce(['s1']);

      await processor.process(sweepJob(JOB_TYPES.PARENT_REPORT.SWEEP_WEEKLY));

      const [, periodKey] = jobs.enqueueBuildBatch.mock.calls[0] as [unknown, string];
      expect(periodKey).toBe('w2026-08-03');
    });
  });

  describe('build', () => {
    it('aggregates and hands the report to the notification pipeline', async () => {
      await processor.process(buildJob());

      expect(aggregator.aggregate).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ key: 'w2026-08-03', type: ParentReportType.WEEKLY }),
      );
      expect(reports.markGenerated).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({
          hasActivity: true,
        }),
      );

      const delivery = notifications.enqueueDelivery.mock.calls[0]?.[0] as {
        eventType: ParentEventType;
        studentId: string;
        subjectId: string;
        variables: Record<string, unknown>;
      };
      expect(delivery.eventType).toBe(ParentEventType.WEEKLY_REPORT);
      // Student MUST be in the subject: a guardian with two children would
      // otherwise collide on one key per period and lose a child's report.
      expect(delivery.subjectId).toBe('s1:w2026-08-03');
      expect(delivery.variables).toMatchObject({
        studentName: 'Ahmed',
        periodType: ParentReportType.WEEKLY,
        periodStart: '2026-08-03',
        periodEnd: '2026-08-09',
      });

      expect(reports.markDispatched).toHaveBeenCalledWith('r1', 1);
    });

    it('is a no-op when the period was already dispatched (duplicate scheduler run)', async () => {
      reports.claim.mockResolvedValueOnce({
        claimed: false,
        report: { id: 'r1', status: ParentReportStatus.DISPATCHED },
      });

      await processor.process(buildJob());

      expect(aggregator.aggregate).not.toHaveBeenCalled();
      expect(notifications.enqueueDelivery).not.toHaveBeenCalled();
    });

    it('re-checks guardian eligibility at build time and skips when it lapsed', async () => {
      // The sweep's candidate list is stale by construction; a guardian who
      // switched the toggle off in between must not receive this report.
      guardians.findNotificationTargets.mockResolvedValueOnce([]);

      await processor.process(buildJob());

      expect(notifications.enqueueDelivery).not.toHaveBeenCalled();
      expect(reports.markSkipped).toHaveBeenCalledWith(
        'r1',
        expect.stringContaining('No eligible'),
      );
      expect(aggregator.aggregate).not.toHaveBeenCalled();
    });

    it('records the failure and rethrows so only this student retries', async () => {
      aggregator.aggregate.mockRejectedValueOnce(new Error('deadlock detected'));

      await expect(processor.process(buildJob())).rejects.toThrow('deadlock detected');

      expect(reports.markFailed).toHaveBeenCalledWith('r1', 'deadlock detected');
      expect(notifications.enqueueDelivery).not.toHaveBeenCalled();
      // FAILED is deliberately non-terminal: tomorrow's sweep re-claims it.
      expect(reports.markDispatched).not.toHaveBeenCalled();
    });

    it('still sends a report for a period with no activity', async () => {
      aggregator.aggregate.mockResolvedValueOnce(emptyReportPayload());

      await processor.process(buildJob());

      // A parent who asked for a weekly update is entitled to learn the week
      // was empty — that is often the most actionable thing it can say.
      expect(notifications.enqueueDelivery).toHaveBeenCalledTimes(1);
      expect(reports.markDispatched).toHaveBeenCalled();
    });

    it('refuses a malformed payload permanently rather than retrying it', async () => {
      await expect(
        processor.process(buildJob({ resolvedAt: 'not-a-date' })),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(reports.claim).not.toHaveBeenCalled();
    });

    it('re-derives the period from resolvedAt instead of trusting stored bounds', async () => {
      await processor.process(
        buildJob({ reportType: ParentReportType.MONTHLY, resolvedAt: '2026-08-01T06:00:00.000Z' }),
      );

      expect(aggregator.aggregate).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ key: 'm2026-07' }),
      );
    });
  });

  it('ignores an unknown job name without throwing', async () => {
    await expect(processor.process(sweepJob('who-knows'))).resolves.toBeUndefined();
    expect(jobs.enqueueBuildBatch).not.toHaveBeenCalled();
  });
});
