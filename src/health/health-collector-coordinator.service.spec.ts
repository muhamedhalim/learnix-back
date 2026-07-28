import type { ConfigService } from '@nestjs/config';

import { HealthCollectorCoordinatorService } from './health-collector-coordinator.service';

class SharedRedis {
  public readonly data = new Map<string, string>();
  public status = 'ready';

  public async set(key: string, value: string, ...options: unknown[]): Promise<'OK' | null> {
    if (options.includes('NX') && this.data.has(key)) return null;
    this.data.set(key, value);
    return 'OK';
  }

  public async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  public async eval(script: string, _keys: number, key: string, token: string): Promise<number> {
    if (this.data.get(key) !== token) return 0;
    if (script.includes("'del'")) this.data.delete(key);
    return 1;
  }

  public disconnect(): void {
    this.status = 'end';
  }
}

function coordinator(redis: SharedRedis, instanceId: string): HealthCollectorCoordinatorService {
  const values: Record<string, string> = {
    NODE_ENV: 'production',
    INSTANCE_ID: instanceId,
    PROCESS_ROLE: 'api',
    HEALTH_COLLECTOR_PROCESS_ROLE: 'api',
    HEALTH_COLLECTOR_CADENCE_SECONDS: '60',
    HEALTH_COLLECTOR_LOCK_TTL_MS: '120000',
  };
  const service = new HealthCollectorCoordinatorService({
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService);
  (
    service as unknown as {
      redis: SharedRedis;
    }
  ).redis = redis;
  return service;
}

describe('HealthCollectorCoordinatorService integration', () => {
  it('prevents duplicate collection across replicas and permits the next cycle after release', async () => {
    const redis = new SharedRedis();
    const first = coordinator(redis, 'replica-a');
    const second = coordinator(redis, 'replica-b');

    const firstLease = await first.acquireLease('collection');
    expect(typeof firstLease).toBe('object');
    expect(await second.acquireLease('collection')).toBe('distributed_lock');

    if (typeof firstLease !== 'string') await firstLease.release();
    const recoveredLease = await second.acquireLease('collection');
    expect(typeof recoveredLease).toBe('object');
    if (typeof recoveredLease !== 'string') await recoveredLease.release();
  });

  it('publishes heartbeat only after success and preserves recovery history after failure', async () => {
    const redis = new SharedRedis();
    const service = coordinator(redis, 'replica-a');
    const firstStart = new Date('2026-07-29T00:00:00.000Z');
    const firstCompletion = new Date('2026-07-29T00:00:02.000Z');

    await service.recordStarted(firstStart);
    expect(redis.data.has('learnix:health:collector:heartbeat:v2')).toBe(false);
    await service.recordCompleted(firstStart, firstCompletion);
    expect(redis.data.has('learnix:health:collector:heartbeat:v2')).toBe(true);

    const failedStart = new Date('2026-07-29T00:01:00.000Z');
    await service.recordStarted(failedStart);
    await service.recordFailed(
      failedStart,
      new Date('2026-07-29T00:01:01.000Z'),
      'DATABASE_UNAVAILABLE',
    );
    const failedState = await service.readState();
    expect(failedState).toMatchObject({
      completedAt: firstCompletion.toISOString(),
      failedAt: '2026-07-29T00:01:01.000Z',
      lastErrorCategory: 'DATABASE_UNAVAILABLE',
    });

    const recoveryStart = new Date('2026-07-29T00:02:00.000Z');
    const recoveryCompletion = new Date('2026-07-29T00:02:03.000Z');
    await service.recordStarted(recoveryStart);
    await service.recordCompleted(recoveryStart, recoveryCompletion);
    expect(await service.readState()).toMatchObject({
      completedAt: recoveryCompletion.toISOString(),
      durationMs: 3_000,
      lastErrorCategory: null,
      running: false,
    });
  });

  it('skips non-designated processes without recording failure', async () => {
    const redis = new SharedRedis();
    const values: Record<string, string> = {
      NODE_ENV: 'production',
      INSTANCE_ID: 'worker-a',
      PROCESS_ROLE: 'worker',
      HEALTH_COLLECTOR_PROCESS_ROLE: 'api',
    };
    const service = new HealthCollectorCoordinatorService({
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService);
    (
      service as unknown as {
        redis: SharedRedis;
      }
    ).redis = redis;
    expect(await service.acquireLease('collection')).toBe('process_role');
    await service.recordSkipped('process_role');
    expect((await service.readState())?.failedAt).toBeNull();
  });
});
