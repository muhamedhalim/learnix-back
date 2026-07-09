import type { ConfigService } from '@nestjs/config';

import type { Cache } from 'cache-manager';

import { DistributedSingleFlightService } from './distributed-single-flight.service';

function createService(
  cache: Partial<Cache>,
  config: Record<string, string> = {},
): DistributedSingleFlightService {
  return new DistributedSingleFlightService(
    cache as Cache,
    {
      get: jest.fn((key: string) => config[key]),
    } as unknown as ConfigService,
  );
}

describe('DistributedSingleFlightService', () => {
  it('shares one computation across 50 concurrent local callers', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(cache);
    let release!: (value: { value: number }) => void;
    const compute = jest.fn(
      () =>
        new Promise<{ value: number }>((resolve) => {
          release = resolve;
        }),
    );

    const requests = Array.from({ length: 50 }, () =>
      service.getOrCompute('dashboard:admin', 300_000, compute),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(compute).toHaveBeenCalledTimes(1);
    release({ value: 42 });

    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 50 }, () => ({ value: 42 })),
    );
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('times out and computes once locally when another replica keeps the lock', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(cache, {
      CACHE_LOCK_WAIT_TIMEOUT_MS: '5',
      CACHE_LOCK_POLL_INTERVAL_MS: '1',
    });
    const redis = {
      isReady: true,
      set: jest.fn().mockResolvedValue(null),
    };
    Object.assign(service, { redisClient: redis });
    const compute = jest.fn().mockResolvedValue({ value: 7 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.getOrCompute('dashboard:admin', 300_000, compute)),
    );

    expect(results).toEqual(Array.from({ length: 10 }, () => ({ value: 7 })));
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalled();
  });
});
