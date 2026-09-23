import type { Cache } from 'cache-manager';

import { ApplicationCacheService } from './application-cache.service';

describe('ApplicationCacheService', () => {
  it('builds isolated v2 keys for tenant, owner scope, and query dimensions', () => {
    const service = new ApplicationCacheService({} as Cache, {} as never);
    const base = {
      family: 'student_report' as const,
      endpoint: 'reports.student-progress',
      ttlMs: 30_000,
      parts: ['student-a', { page: 1 }],
    };

    const ownerA = service.buildKey({ ...base, tenant: 'tenant-a', scope: 'owner:student-a' });
    const ownerB = service.buildKey({ ...base, tenant: 'tenant-a', scope: 'owner:student-b' });
    const tenantB = service.buildKey({ ...base, tenant: 'tenant-b', scope: 'owner:student-a' });

    expect(ownerA).toMatch(/^v2:tenant:[\w-]+:scope:[\w-]+:family:student_report:/);
    expect(ownerA).not.toContain('student-a');
    expect(ownerA).not.toEqual(ownerB);
    expect(ownerA).not.toEqual(tenantB);
  });

  describe('key hygiene', () => {
    const service = new ApplicationCacheService({} as Cache, {} as never);
    const base = {
      family: 'teacher_dashboard' as const,
      endpoint: 'analytics.teacher-dashboard',
      scope: 'owner:teacher-a',
      ttlMs: 30_000,
    };

    it('separates two endpoints that share family, scope and parts', () => {
      const a = service.buildKey({ ...base, endpoint: 'analytics.teacher-dashboard', parts: ['t'] });
      const b = service.buildKey({ ...base, endpoint: 'analytics.teacher-report', parts: ['t'] });

      expect(a).not.toEqual(b);
      expect(a).not.toContain('analytics');
    });

    it('is independent of property order and of undefined properties', () => {
      const withUndefined = service.buildKey({ ...base, parts: [{ a: 1, b: undefined, c: 2 }] });
      const reordered = service.buildKey({ ...base, parts: [{ c: 2, a: 1 }] });

      expect(withUndefined).toEqual(reordered);
    });

    it('normalizes nested objects and objects inside arrays', () => {
      const one = service.buildKey({ ...base, parts: [{ f: { y: 2, x: 1, z: undefined }, l: [{ q: 1, p: 2 }] }] });
      const two = service.buildKey({ ...base, parts: [{ l: [{ p: 2, q: 1 }], f: { x: 1, y: 2 } }] });

      expect(one).toEqual(two);
    });

    it('keeps null distinct from an absent property, and array order significant', () => {
      const absent = service.buildKey({ ...base, parts: [{ a: 1 }] });
      const explicitNull = service.buildKey({ ...base, parts: [{ a: 1, b: null }] });
      const ab = service.buildKey({ ...base, parts: [['a', 'b']] });
      const ba = service.buildKey({ ...base, parts: [['b', 'a']] });

      expect(absent).not.toEqual(explicitNull);
      expect(ab).not.toEqual(ba);
    });

    it('treats a Date like its ISO string so equivalent inputs share a key', () => {
      const asDate = service.buildKey({ ...base, parts: [{ from: new Date('2026-01-01T00:00:00.000Z') }] });
      const asString = service.buildKey({ ...base, parts: [{ from: '2026-01-01T00:00:00.000Z' }] });

      expect(asDate).toEqual(asString);
    });

    it('still keeps different part values apart and hides raw ids', () => {
      const a = service.buildKey({ ...base, parts: [{ id: 'teacher-a' }] });
      const b = service.buildKey({ ...base, parts: [{ id: 'teacher-b' }] });

      expect(a).not.toEqual(b);
      expect(a).not.toContain('teacher-a');
    });
  });

  it('uses generation invalidation rather than wildcard deletion', async () => {
    const values = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => values.get(key)),
      mget: jest.fn(async (keys: string[]) => keys.map((key) => values.get(key))),
      set: jest.fn(async (key: string, value: unknown) => values.set(key, value)),
    };
    const singleFlight = {
      getOrCompute: jest.fn(async (_key: string, _ttl: number, compute: () => Promise<unknown>) => await compute()),
    };
    const service = new ApplicationCacheService(cache as unknown as Cache, singleFlight as never);
    const descriptor = {
      family: 'teacher_dashboard' as const,
      endpoint: 'analytics.teacher-dashboard',
      scope: 'owner:teacher-a',
      parts: ['teacher-a'],
      ttlMs: 30_000,
    };

    await service.getOrCompute(descriptor, async () => ({ value: 1 }));
    const firstKey = singleFlight.getOrCompute.mock.calls[0]?.[0] as string;
    await service.invalidate(['teacher_dashboard']);
    await service.getOrCompute(descriptor, async () => ({ value: 2 }));
    const secondKey = singleFlight.getOrCompute.mock.calls[1]?.[0] as string;

    expect(firstKey).not.toEqual(secondKey);
    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining('cache-generation'), expect.any(String), 86_400_000);
    expect((cache as { del?: jest.Mock }).del).toBeUndefined();
  });

  it('reads both generations with exactly one mget and no per-key get', async () => {
    const cache = {
      get: jest.fn(),
      mget: jest.fn(async (keys: string[]) => keys.map(() => undefined)),
      set: jest.fn(),
    };
    const singleFlight = {
      getOrCompute: jest.fn(async (_key: string, _ttl: number, compute: () => Promise<unknown>) => await compute()),
    };
    const service = new ApplicationCacheService(cache as unknown as Cache, singleFlight as never);

    await service.getOrCompute(
      {
        family: 'student_report' as const,
        endpoint: 'reports.student-progress',
        scope: 'owner:student-a',
        parts: ['student-a'],
        ttlMs: 30_000,
      },
      async () => ({ value: 1 }),
    );

    expect(cache.mget).toHaveBeenCalledTimes(1);
    const keys = cache.mget.mock.calls[0]?.[0] as string[];
    // global, family and owner-scope generations are still ONE round trip.
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/:family:global$/);
    expect(keys[1]).toMatch(/:family:student_report$/);
    expect(keys[2]).toMatch(/:family:student_report:scope:[\w-]+$/);
    expect(keys[2]).not.toContain('student-a');
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('treats an absent generation as 0 in the cache key', async () => {
    const cache = { mget: jest.fn(async () => [undefined, 'fam-7', undefined]), set: jest.fn() };
    const singleFlight = {
      getOrCompute: jest.fn(async (_key: string, _ttl: number, compute: () => Promise<unknown>) => await compute()),
    };
    const service = new ApplicationCacheService(cache as unknown as Cache, singleFlight as never);
    const descriptor = {
      family: 'student_report' as const,
      endpoint: 'reports.student-progress',
      scope: 'owner:student-a',
      parts: ['student-a'],
      ttlMs: 30_000,
    };

    await service.getOrCompute(descriptor, async () => ({ value: 1 }));

    expect(singleFlight.getOrCompute.mock.calls[0]?.[0]).toEqual(
      service.buildKey(descriptor, '0.fam-7.0'),
    );
  });

  describe('owner-scoped generations', () => {
    function harness() {
      const values = new Map<string, unknown>();
      const cache = {
        get: jest.fn(async (key: string) => values.get(key)),
        mget: jest.fn(async (keys: string[]) => keys.map((key) => values.get(key))),
        set: jest.fn(async (key: string, value: unknown) => values.set(key, value)),
      };
      const singleFlight = {
        getOrCompute: jest.fn(async (_key: string, _ttl: number, compute: () => Promise<unknown>) => await compute()),
      };
      const service = new ApplicationCacheService(cache as unknown as Cache, singleFlight as never);
      const keyFor = async (
        scope: string,
        family: 'student_report' | 'teacher_report' = 'student_report',
      ) => {
        const before = singleFlight.getOrCompute.mock.calls.length;
        await service.getOrCompute(
          { family, endpoint: 'reports.student-progress', scope, parts: ['x'], ttlMs: 30_000 },
          async () => ({}),
        );
        return singleFlight.getOrCompute.mock.calls[before]?.[0] as string;
      };
      return { cache, service, keyFor };
    }

    it('changes only the invalidated owner key, not another owner in the same family', async () => {
      const { service, keyFor } = harness();
      const aBefore = await keyFor('owner:student-a');
      const bBefore = await keyFor('owner:student-b');

      await service.invalidateScopes([{ family: 'student_report', scope: 'owner:student-a' }]);

      expect(await keyFor('owner:student-a')).not.toEqual(aBefore);
      expect(await keyFor('owner:student-b')).toEqual(bBefore);
    });

    it('leaves the same owner in a different family untouched', async () => {
      const { service, keyFor } = harness();
      const teacherReportBefore = await keyFor('owner:student-a', 'teacher_report');

      await service.invalidateScopes([{ family: 'student_report', scope: 'owner:student-a' }]);

      expect(await keyFor('owner:student-a', 'teacher_report')).toEqual(teacherReportBefore);
    });

    it('changes every owner when the whole family or the global generation is bumped', async () => {
      const { service, keyFor } = harness();
      const aBefore = await keyFor('owner:student-a');
      const bBefore = await keyFor('owner:student-b');

      await service.invalidate(['student_report']);
      const aFamily = await keyFor('owner:student-a');
      const bFamily = await keyFor('owner:student-b');
      expect(aFamily).not.toEqual(aBefore);
      expect(bFamily).not.toEqual(bBefore);

      await service.invalidateAll();
      expect(await keyFor('owner:student-a')).not.toEqual(aFamily);
      expect(await keyFor('owner:student-b')).not.toEqual(bFamily);
    });

    it('writes only the scope generation, hashed, with the 24 h generation TTL', async () => {
      const { cache, service } = harness();

      await service.invalidateScopes([{ family: 'student_report', scope: 'owner:student-a' }]);

      expect(cache.set).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = cache.set.mock.calls[0] as [string, string, number];
      expect(key).toMatch(/:family:student_report:scope:[\w-]+$/);
      expect(key).not.toContain('student-a');
      expect(value).toEqual(expect.any(String));
      expect(ttl).toBe(86_400_000);
    });

    it('keeps a cache hit at one mget whatever the generation levels', async () => {
      const { cache, service, keyFor } = harness();
      await service.invalidateScopes([{ family: 'student_report', scope: 'owner:student-a' }]);
      cache.mget.mockClear();

      await keyFor('owner:student-a');

      expect(cache.mget).toHaveBeenCalledTimes(1);
      expect(cache.get).not.toHaveBeenCalled();
    });
  });
});
