import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { mockClient } from 'aws-sdk-client-mock';

import { standaloneQueueOptions } from '../queues/queue-options.util';
import { DEAD_LETTER_METRIC, QUEUE_BACKLOG_METRIC, QueueMetricsPublisher, summariseCounts } from './queue-metrics.publisher';

describe('summariseCounts', () => {
  it('sums ready jobs on work queues and parks dead-letter jobs separately', () => {
    expect(
      summariseCounts([
        { name: 'email', counts: { waiting: 3, prioritized: 2, failed: 9 } },
        { name: 'exam-omr', counts: { waiting: 10 } },
        { name: 'parent-notifications-dlq', counts: { waiting: 1, failed: 4 } },
      ]),
    ).toEqual({ backlog: 15, deadLetter: 5 });
  });
});

describe('standaloneQueueOptions', () => {
  const env = (values: Record<string, string>) => (key: string) => values[key];

  it('is null without Redis', () => {
    expect(standaloneQueueOptions(env({}))).toBeNull();
  });

  it('carries the namespace prefix the queue module uses (staging)', () => {
    expect(standaloneQueueOptions(env({ REDIS_URL: 'redis://localhost:6379', APP_ENV: 'staging' }))).toEqual({
      connection: { url: 'redis://localhost:6379' },
      prefix: 'learnix:staging',
    });
  });

  it('keeps BullMQ\'s default prefix when there is no namespace', () => {
    expect(standaloneQueueOptions(env({ REDIS_URL: 'redis://localhost:6379' }))).toEqual({
      connection: { url: 'redis://localhost:6379' },
    });
  });
});

describe('QueueMetricsPublisher', () => {
  const cloudwatch = mockClient(CloudWatchClient);
  const ORIGINAL_ROLE = process.env['PROCESS_ROLE'];

  afterEach(() => {
    cloudwatch.reset();
    if (ORIGINAL_ROLE === undefined) delete process.env['PROCESS_ROLE'];
    else process.env['PROCESS_ROLE'] = ORIGINAL_ROLE;
  });

  function config(values: Record<string, string>) {
    return { get: (key: string) => values[key] } as never;
  }

  it('stays off without QUEUE_METRICS_NAMESPACE', async () => {
    const publisher = new QueueMetricsPublisher(config({ REDIS_URL: 'redis://localhost:6379' }));
    publisher.onModuleInit();
    await expect(publisher.publishOnce()).resolves.toBeNull();
    expect(cloudwatch.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  it('stays off in api-only processes (no queue consumers there)', async () => {
    process.env['PROCESS_ROLE'] = 'api';
    const publisher = new QueueMetricsPublisher(
      config({ REDIS_URL: 'redis://localhost:6379', QUEUE_METRICS_NAMESPACE: 'Learnix/Queues' }),
    );
    publisher.onModuleInit();
    await expect(publisher.publishOnce()).resolves.toBeNull();
  });

  it('publishes backlog and dead-letter counts with the environment dimension', async () => {
    process.env['PROCESS_ROLE'] = 'worker';
    cloudwatch.on(PutMetricDataCommand).resolves({});
    const publisher = new QueueMetricsPublisher(
      config({
        REDIS_URL: 'redis://localhost:6379',
        QUEUE_METRICS_NAMESPACE: 'Learnix/Queues',
        QUEUE_METRICS_ENVIRONMENT: 'learnix-staging',
      }),
    );
    publisher.onModuleInit();
    // Replace the real Redis-backed queues with fakes.
    const internals = publisher as unknown as { queues: Array<{ name: string; getJobCounts: () => Promise<Record<string, number>>; close: () => Promise<void> }> };
    await Promise.allSettled(internals.queues.map((q) => q.close()));
    internals.queues = [
      { name: 'email', getJobCounts: () => Promise.resolve({ waiting: 7 }), close: () => Promise.resolve() },
      { name: 'parent-notifications-dlq', getJobCounts: () => Promise.resolve({ failed: 2 }), close: () => Promise.resolve() },
    ];

    await expect(publisher.publishOnce()).resolves.toEqual({ backlog: 7, deadLetter: 2 });
    const input = cloudwatch.commandCalls(PutMetricDataCommand)[0]!.args[0].input;
    expect(input.Namespace).toBe('Learnix/Queues');
    expect(input.MetricData?.map((m) => [m.MetricName, m.Value, m.Dimensions?.[0]?.Value])).toEqual([
      [QUEUE_BACKLOG_METRIC, 7, 'learnix-staging'],
      [DEAD_LETTER_METRIC, 2, 'learnix-staging'],
    ]);
    await publisher.onModuleDestroy();
  });

  it('never throws when CloudWatch rejects the call', async () => {
    process.env['PROCESS_ROLE'] = 'worker';
    cloudwatch.on(PutMetricDataCommand).rejects(new Error('AccessDenied'));
    const publisher = new QueueMetricsPublisher(
      config({ REDIS_URL: 'redis://localhost:6379', QUEUE_METRICS_NAMESPACE: 'Learnix/Queues' }),
    );
    publisher.onModuleInit();
    const internals = publisher as unknown as { queues: unknown[] };
    await Promise.allSettled((internals.queues as Array<{ close: () => Promise<void> }>).map((q) => q.close()));
    internals.queues = [{ name: 'email', getJobCounts: () => Promise.resolve({ waiting: 1 }), close: () => Promise.resolve() }];
    await expect(publisher.publishOnce()).resolves.toBeNull();
    await publisher.onModuleDestroy();
  });
});
