import { Job } from 'bullmq';

import { ParentEventType } from '../common/events/parent-event-type.enum';
import { PushNotificationJobsService } from '../notifications/services/push-notification-jobs.service';
import { ParentNotificationJobsService } from '../notifications/services/parent-notification-jobs.service';
import { ParentReportJobsService } from '../parent-reports/services/parent-report-jobs.service';
import { queueJobId } from './job-id.util';
import { areQueuesEnabled } from './queues.constants';

jest.mock('./queues.constants', () => ({
  ...jest.requireActual<typeof import('./queues.constants')>('./queues.constants'),
  areQueuesEnabled: jest.fn(),
}));

/**
 * Runs BullMQ's own option validation (the check `queue.add` performs before writing to Redis) without a
 * Redis connection, so these tests fail exactly where production failed with "Custom Id cannot contain :".
 */
function bullmqRejection(jobId: string): string | null {
  const queue = {
    opts: { prefix: 'bull' },
    name: 'q',
    qualifiedName: 'bull:q',
    keys: {},
    toKey: (key: string) => `bull:q:${key}`,
    client: Promise.resolve({}),
    redisVersion: '7.0.0',
    trace: async (...args: unknown[]) => (args.at(-1) as () => unknown)(),
  };
  const job = new Job(queue as never, 'n', {}, { jobId });
  try {
    (job as unknown as { validateOptions: (data: unknown) => void }).validateOptions(job.asJSON());
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const UUID = '7f3c1e2a-9b4d-4c61-8a0e-2d5f6b7c8d9e';

describe('queueJobId', () => {
  it('reproduces the production failure: BullMQ rejects the ids the worker used to build', () => {
    expect(bullmqRejection(`push:${UUID}`)).toBe('Custom Id cannot contain :');
    expect(bullmqRejection(`push:${UUID}:retry:lx2k`)).toBe('Custom Id cannot contain :');
    expect(bullmqRejection(`parent-report:weekly:${UUID}:w2026-10-12`)).toBe(
      'Custom Id cannot contain :',
    );
  });

  it('builds deterministic ids that BullMQ accepts', () => {
    const id = queueJobId('push', UUID, 'retry', 'lx2k');
    expect(id).toBe(`push.${UUID}.retry.lx2k`);
    expect(queueJobId('push', UUID, 'retry', 'lx2k')).toBe(id);
    expect(bullmqRejection(id)).toBeNull();
    expect(bullmqRejection(queueJobId('meeting', 'provision', UUID))).toBeNull();
  });

  it('refuses a part that would reintroduce a colon, an empty part, or a bare id', () => {
    expect(() => queueJobId('push', 'a:b')).toThrow(/no ':'/);
    expect(() => queueJobId('push', '')).toThrow(/non-empty/);
    expect(() => queueJobId('push')).toThrow(/prefix/);
  });
});

describe('every enqueue path produces a BullMQ-valid job id', () => {
  const capture = () => {
    const ids: string[] = [];
    const queue = {
      add: jest.fn(async (_name: string, _data: unknown, opts: { jobId: string }) => {
        ids.push(opts.jobId);
        return { id: opts.jobId };
      }),
      addBulk: jest.fn(async (jobs: Array<{ opts: { jobId: string } }>) => {
        for (const job of jobs) ids.push(job.opts.jobId);
        return [];
      }),
    };
    return { ids, queue };
  };

  beforeEach(() => (areQueuesEnabled as jest.Mock).mockReturnValue(true));

  it('push delivery, bulk push and the 5-minute recovery retry (forceNewJob)', async () => {
    const { ids, queue } = capture();
    const service = new PushNotificationJobsService(queue as never, {} as never, {} as never);
    await service.enqueueDelivery(UUID);
    await service.enqueueDelivery(UUID, { forceNewJob: true });
    await service.enqueueDeliveryMany([UUID]);

    expect(ids).toHaveLength(3);
    for (const id of ids) expect([id, bullmqRejection(id)]).toEqual([id, null]);
  });

  it('parent notification delivery, admin retry and redelivery', async () => {
    const { ids, queue } = capture();
    const service = new ParentNotificationJobsService(queue as never, {} as never);
    const job = {
      eventType: ParentEventType.EXAM_GRADED,
      studentId: UUID,
      subjectId: UUID,
      variables: {},
    };
    await service.enqueueDelivery(job as never);
    await service.enqueueDelivery(job as never, { bypassDedup: true });
    await service.enqueueRedelivery(UUID);

    expect(ids).toHaveLength(3);
    for (const id of ids) expect([id, bullmqRejection(id)]).toEqual([id, null]);
  });

  it('parent report builds, single and batched', async () => {
    const { ids, queue } = capture();
    const service = new ParentReportJobsService(queue as never);
    const job = { studentId: UUID, reportType: 'weekly', resolvedAt: '2026-10-19T00:00:00.000Z' };
    await service.enqueueBuild(job as never, 'w2026-10-12');
    await service.enqueueBuildBatch([job as never], 'm2026-09');

    expect(ids).toHaveLength(2);
    for (const id of ids) expect([id, bullmqRejection(id)]).toEqual([id, null]);
  });
});
