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

  it('uses generation invalidation rather than wildcard deletion', async () => {
    const values = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => values.get(key)),
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
});
