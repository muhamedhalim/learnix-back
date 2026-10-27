import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';

import { DistributedSingleFlightService } from '../../src/common/cache/distributed-single-flight.service';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';
import { createE2EApp } from './helpers/app-factory';

interface RedisClientState {
  isOpen?: boolean;
  status?: string;
}

interface ServiceWithRedisClient {
  redisClient?: RedisClientState;
}

interface ThrottlerWithRedisClient {
  redis?: RedisClientState;
}

interface CacheClient {
  del(key: string): Promise<boolean>;
  get<Value>(key: string): Promise<Value | undefined>;
  set(key: string, value: unknown, ttl?: number): Promise<unknown>;
}

describe('Redis lifecycle (e2e)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it('closes every application-owned Redis client', async () => {
    const ctx = await createE2EApp();
    app = ctx.app;

    const throttler = app.get<ThrottlerWithRedisClient>(ThrottlerStorage);
    const idempotency = app.get(IdempotencyService) as unknown as ServiceWithRedisClient;
    const singleFlight = app.get(DistributedSingleFlightService) as unknown as ServiceWithRedisClient;
    const cacheManager = app.get<CacheClient>(CACHE_MANAGER);

    expect(throttler.redis?.status).toBe('ready');
    expect(idempotency.redisClient?.isOpen).toBe(true);
    expect(singleFlight.redisClient?.isOpen).toBe(true);
    await cacheManager.set('redis-lifecycle-probe', { active: true }, 5000);
    await expect(cacheManager.get('redis-lifecycle-probe')).resolves.toEqual({ active: true });
    await cacheManager.del('redis-lifecycle-probe');

    await app.close();
    app = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(throttler.redis?.status).toBe('end');
    expect(idempotency.redisClient?.isOpen).toBe(false);
    expect(singleFlight.redisClient?.isOpen).toBe(false);
    expect(activeRedisSocketCount()).toBe(0);
  });
});

function activeRedisSocketCount(): number {
  const handles = (
    process as unknown as {
      _getActiveHandles(): Array<{ remotePort?: number }>;
    }
  )._getActiveHandles();

  return handles.filter((handle) => handle.remotePort === 6379).length;
}
