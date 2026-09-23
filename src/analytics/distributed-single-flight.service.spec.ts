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
  describe('contended waiter back-off', () => {
    type DelayHost = { delay: (milliseconds: number) => Promise<void> };

    async function contendedRun(config: Record<string, string>): Promise<{
      delays: number[];
      redisSet: jest.Mock;
      cacheGet: jest.Mock;
      compute: jest.Mock;
      result: unknown;
    }> {
      jest.useFakeTimers();
      const cache = {
        get: jest.fn().mockResolvedValue(undefined),
        set: jest.fn().mockResolvedValue(undefined),
      };
      const service = createService(cache, config);
      const redis = { isReady: true, set: jest.fn().mockResolvedValue(null) };
      Object.assign(service, { redisClient: redis });
      const delays: number[] = [];
      const original = (service as unknown as DelayHost).delay.bind(service);
      jest.spyOn(service as unknown as DelayHost, 'delay').mockImplementation(async (ms) => {
        delays.push(ms);
        await original(ms);
      });
      const compute = jest.fn().mockResolvedValue({ value: 9 });

      const pending = service.getOrCompute('dashboard:admin', 300_000, compute);
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      return { delays, redisSet: redis.set, cacheGet: cache.get, compute, result };
    }

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('starts at the configured poll interval, doubles, and stays capped', async () => {
      const { delays } = await contendedRun({
        CACHE_LOCK_WAIT_TIMEOUT_MS: '3000',
        CACHE_LOCK_POLL_INTERVAL_MS: '50',
      });

      expect(delays[0]).toBe(50);
      expect(delays[1]).toBe(100);
      expect(delays[2]).toBe(200);
      expect(Math.max(...delays)).toBeLessThanOrEqual(250);
      for (let i = 1; i < delays.length - 1; i++) {
        expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
      }
    });

    it('issues one SET NX and one GET per poll and a bounded number of polls with defaults', async () => {
      const { delays, redisSet, cacheGet, compute, result } = await contendedRun({
        CACHE_LOCK_WAIT_TIMEOUT_MS: '3000',
      });

      expect(delays[0]).toBe(20);
      // 20 -> 40 -> 80 -> 160 -> 250 ... within 3000 ms is about 15 polls, versus 150 at a fixed 20 ms.
      expect(redisSet.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(redisSet.mock.calls.length).toBeLessThanOrEqual(20);
      // One initial cache lookup, then exactly one GET alongside each poll's SET NX.
      expect(cacheGet).toHaveBeenCalledTimes(redisSet.mock.calls.length + 1);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ value: 9 });
    });

    it('never sleeps past the wait budget and still falls back to one local compute', async () => {
      const { delays, compute, result } = await contendedRun({
        CACHE_LOCK_WAIT_TIMEOUT_MS: '300',
        CACHE_LOCK_POLL_INTERVAL_MS: '100',
      });

      expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(300);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ value: 9 });
    });

    it('honours a poll interval above the ceiling as its own ceiling', async () => {
      const { delays } = await contendedRun({
        CACHE_LOCK_WAIT_TIMEOUT_MS: '3000',
        CACHE_LOCK_POLL_INTERVAL_MS: '400',
      });

      expect(delays[0]).toBe(400);
      expect(Math.max(...delays)).toBeLessThanOrEqual(400);
    });
  });
});
