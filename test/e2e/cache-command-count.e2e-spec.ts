import { randomUUID } from 'node:crypto';

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { INestApplication } from '@nestjs/common';

import type { Cache } from 'cache-manager';

import {
  ApplicationCacheService,
  type ApplicationCacheDescriptor,
} from '../../src/common/cache/application-cache.service';
import { RedisKeyvStore } from '../../src/common/cache/redis-keyv.store';
import { createE2EApp } from './helpers/app-factory';

/**
 * The slice of the node-redis client the cache store talks to. Declared here so
 * the spies do not have to instantiate node-redis's very large command typings.
 */
interface StoreCommandClient {
  get(key: string): Promise<string | null>;
  mGet(keys: string[]): Promise<Array<string | null>>;
  set(...args: unknown[]): Promise<unknown>;
  del(...args: unknown[]): Promise<number>;
}

interface GenerationKeyBuilder {
  versionKey(tenant: string, family: string, scope?: string): string;
}

/**
 * T034 against a real Redis: cache-manager `mget` reaches the store as ONE
 * `MGET`, a cache hit costs exactly two Redis reads whatever the number of
 * generation levels in the key, and T035's owner-scoped generation moves only
 * the invalidated owner's key material.
 *
 * The spies are on the node-redis client the cache store owns (reached through
 * `cacheManager.stores[0].store.client`), i.e. they count actual Redis commands,
 * not calls into a mock.
 */
describe('cache Redis command count (e2e, T034/T035)', () => {
  let app: INestApplication;
  let cacheManager: Cache;
  let applicationCache: ApplicationCacheService;
  let client: StoreCommandClient;

  beforeAll(async () => {
    ({ app } = await createE2EApp());
    cacheManager = app.get<Cache>(CACHE_MANAGER);
    applicationCache = app.get(ApplicationCacheService);

    const store = cacheManager.stores[0]?.store as unknown;
    if (!(store instanceof RedisKeyvStore)) {
      throw new Error(
        'The e2e cache manager is not backed by RedisKeyvStore; is REDIS_HOST set in .env.test?',
      );
    }
    client = (store as unknown as { client: StoreCommandClient }).client;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => app.close());

  function spyOnRedisCommands() {
    return {
      get: jest.spyOn(client, 'get'),
      mGet: jest.spyOn(client, 'mGet'),
      set: jest.spyOn(client, 'set'),
      del: jest.spyOn(client, 'del'),
      storeGet: jest.spyOn(RedisKeyvStore.prototype, 'get'),
      storeGetMany: jest.spyOn(RedisKeyvStore.prototype, 'getMany'),
    };
  }

  it('cacheManager.mget([existing, missing]) returns [value, undefined] using a single MGET', async () => {
    const existingKey = `cache-command-count:existing:${randomUUID()}`;
    const missingKey = `cache-command-count:missing:${randomUUID()}`;
    await cacheManager.set(existingKey, { active: true }, 30_000);

    try {
      const commands = spyOnRedisCommands();

      const values = await cacheManager.mget<{ active: boolean }>([existingKey, missingKey]);

      expect(values).toEqual([{ active: true }, undefined]);
      expect(commands.mGet).toHaveBeenCalledTimes(1);
      expect(commands.mGet.mock.calls[0]?.[0]).toHaveLength(2);
      expect(commands.storeGetMany).toHaveBeenCalledTimes(1);
      // Batched: no per-key GET fallback.
      expect(commands.get).not.toHaveBeenCalled();
      expect(commands.storeGet).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      await cacheManager.del(existingKey);
    }
  });

  it('a warmed ApplicationCacheService.getOrCompute hit issues exactly one mGet and one get — 2 Redis reads, with an owner-scoped key', async () => {
    const descriptor: ApplicationCacheDescriptor = {
      family: 'student_report',
      endpoint: 'cache-command-count.hit',
      // Three generation levels are read (global, family, scope): still ONE mGet.
      scope: `owner:${randomUUID()}`,
      parts: [randomUUID()],
      ttlMs: 30_000,
    };
    let computed = 0;
    const compute = async (): Promise<{ payload: string }> => {
      computed += 1;
      return { payload: 'warm' };
    };

    await expect(applicationCache.getOrCompute(descriptor, compute)).resolves.toEqual({
      payload: 'warm',
    });
    expect(computed).toBe(1); // the miss computed and stored the value

    const commands = spyOnRedisCommands();

    await expect(applicationCache.getOrCompute(descriptor, compute)).resolves.toEqual({
      payload: 'warm',
    });

    expect(computed).toBe(1); // a hit, not a recompute
    expect(commands.mGet).toHaveBeenCalledTimes(1);
    expect(commands.mGet.mock.calls[0]?.[0]).toHaveLength(3); // global + family + scope generations
    expect(commands.get).toHaveBeenCalledTimes(1); // the value itself
    // Nothing else: no writes, no deletes, and no per-key generation GETs (the old 3-command hit).
    expect(commands.set).not.toHaveBeenCalled();
    expect(commands.del).not.toHaveBeenCalled();
    // The same counts one layer up, at the Keyv store.
    expect(commands.storeGetMany).toHaveBeenCalledTimes(1);
    expect(commands.storeGet).toHaveBeenCalledTimes(1);
  });

  it('invalidateScopes moves only the invalidated owner’s generation key: same global and family generations, other owner untouched', async () => {
    const ownerA = `owner:${randomUUID()}`;
    const ownerB = `owner:${randomUUID()}`;
    const keys = applicationCache as unknown as GenerationKeyBuilder;
    const globalKey = keys.versionKey('default', 'global');
    const familyKey = keys.versionKey('default', 'student_report');
    const ownerAKey = keys.versionKey('default', 'student_report', ownerA);
    const ownerBKey = keys.versionKey('default', 'student_report', ownerB);
    expect(new Set([globalKey, familyKey, ownerAKey, ownerBKey]).size).toBe(4);

    const descriptorFor = (scope: string): ApplicationCacheDescriptor => ({
      family: 'student_report',
      endpoint: 'cache-command-count.scope',
      scope,
      parts: ['same-parts'],
      ttlMs: 30_000,
    });
    const computedFor: Record<string, number> = { [ownerA]: 0, [ownerB]: 0 };
    const compute = (scope: string) => async (): Promise<string> => {
      computedFor[scope] = (computedFor[scope] ?? 0) + 1;
      return `value-for-${scope}`;
    };

    // Warm both owners, then confirm both are cache hits.
    await applicationCache.getOrCompute(descriptorFor(ownerA), compute(ownerA));
    await applicationCache.getOrCompute(descriptorFor(ownerB), compute(ownerB));
    await applicationCache.getOrCompute(descriptorFor(ownerA), compute(ownerA));
    await applicationCache.getOrCompute(descriptorFor(ownerB), compute(ownerB));
    expect(computedFor).toEqual({ [ownerA]: 1, [ownerB]: 1 });

    const before = await cacheManager.mget<string>([globalKey, familyKey, ownerAKey, ownerBKey]);

    await applicationCache.invalidateScopes([{ family: 'student_report', scope: ownerA }]);

    const after = await cacheManager.mget<string>([globalKey, familyKey, ownerAKey, ownerBKey]);
    expect(after[0]).toBe(before[0]); // global generation unchanged
    expect(after[1]).toBe(before[1]); // family generation unchanged
    expect(after[2]).toEqual(expect.any(String)); // owner A's generation was set...
    expect(after[2]).not.toBe(before[2]); // ...to a new value
    expect(after[3]).toBe(before[3]); // owner B's generation untouched

    // Behaviourally: owner A recomputes, owner B still hits.
    await applicationCache.getOrCompute(descriptorFor(ownerA), compute(ownerA));
    await applicationCache.getOrCompute(descriptorFor(ownerB), compute(ownerB));
    expect(computedFor).toEqual({ [ownerA]: 2, [ownerB]: 1 });
  });
});
