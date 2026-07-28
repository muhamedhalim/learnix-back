import { classifyApiHealth } from './indicators/backend-api.indicator';
import { classifyQueueHealth } from './indicators/queue.indicator';
import { classifyCollectorHeartbeat } from './indicators/scheduler.indicator';

describe('health evidence classification', () => {
  const nominalApi = {
    requests: 100,
    serverErrorRatePercent: 0,
    timeoutRatePercent: 0,
    p95LatencyMs: 100,
    eventLoopDelayMs: 5,
    heapUsagePercent: 30,
  };

  it('degrades the API on a high 5xx rate', () => {
    expect(classifyApiHealth({ ...nominalApi, serverErrorRatePercent: 6 })).toEqual({
      status: 'degraded',
      reasonCode: 'API_5XX_RATE_HIGH',
    });
  });

  it('does not degrade the API due to expected 4xx responses', () => {
    // 4xx is deliberately absent from the operational classification input.
    expect(classifyApiHealth(nominalApi).status).toBe('healthy');
  });

  it.each([
    ['healthy', {}, 'healthy'],
    ['backlog', { backlog: 100 }, 'warning'],
    ['missing worker', { backlog: 1, workerConnected: false }, 'degraded'],
    ['high failures', { failed: 5, completed: 15 }, 'degraded'],
  ] as const)('classifies a %s queue', (_name, overrides, expected) => {
    expect(
      classifyQueueHealth({
        backlog: 0,
        oldestPendingAgeSeconds: null,
        workerConnected: true,
        failed: 0,
        completed: 0,
        stalled: 0,
        retryLoops: 0,
        paused: false,
        isDeadLetterQueue: false,
        ...overrides,
      }).status,
    ).toBe(expected);
  });

  it('keeps an empty queue healthy when no worker is connected', () => {
    expect(
      classifyQueueHealth({
        backlog: 0,
        oldestPendingAgeSeconds: null,
        workerConnected: false,
        failed: 0,
        completed: 0,
        stalled: 0,
        retryLoops: 0,
        paused: false,
        isDeadLetterQueue: false,
      }).status,
    ).toBe('healthy');
  });

  it('marks queue connectivity down when Redis is unavailable', () => {
    expect(
      classifyQueueHealth({
        connected: false,
        backlog: 0,
        oldestPendingAgeSeconds: null,
        workerConnected: null,
        failed: 0,
        completed: 0,
        stalled: 0,
        retryLoops: 0,
        paused: false,
        isDeadLetterQueue: false,
      }),
    ).toEqual({ status: 'down', reasonCode: 'QUEUE_REDIS_UNAVAILABLE' });
  });

  it('degrades a queue when stalled jobs are confirmed', () => {
    expect(
      classifyQueueHealth({
        backlog: 0,
        oldestPendingAgeSeconds: null,
        workerConnected: true,
        failed: 0,
        completed: 0,
        stalled: 1,
        retryLoops: 0,
        paused: false,
        isDeadLetterQueue: false,
      }),
    ).toEqual({ status: 'degraded', reasonCode: 'QUEUE_STALLED_JOBS' });
  });

  it('classifies current, stale, and startup-grace scheduler heartbeats', () => {
    const now = Date.parse('2026-07-29T00:10:00.000Z');
    expect(
      classifyCollectorHeartbeat({
        completedAt: '2026-07-29T00:09:30.000Z',
        cadenceSeconds: 60,
        processUptimeSeconds: 500,
        now,
      }).status,
    ).toBe('healthy');
    expect(
      classifyCollectorHeartbeat({
        completedAt: '2026-07-29T00:04:00.000Z',
        cadenceSeconds: 60,
        processUptimeSeconds: 500,
        now,
      }).status,
    ).toBe('degraded');
    expect(
      classifyCollectorHeartbeat({
        completedAt: null,
        cadenceSeconds: 60,
        processUptimeSeconds: 30,
        now,
      }).status,
    ).toBe('unknown');
  });
});
