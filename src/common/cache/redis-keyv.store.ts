import { EventEmitter } from 'node:events';

import type { RedisClientType } from 'redis';

const DELETE_BATCH_SIZE = 100;

/**
 * Minimal Keyv-compatible adapter for the node-redis client already used by
 * the application. Nest CacheManager v3 wraps this adapter in Keyv and owns
 * its lifecycle through disconnect().
 */
export class RedisKeyvStore extends EventEmitter {
  public readonly opts: Record<string, never> = {};

  /**
   * Full key prefix, e.g. `learnix:cache:` on production (unchanged from
   * before this became a constructor parameter) or
   * `learnix:staging:learnix:cache:` on staging — see
   * `common/utils/redis-namespace.util.ts` for why production's environment
   * namespace defaults to empty and staging's does not.
   */
  private readonly keyPrefix: string;

  public constructor(
    private readonly client: RedisClientType,
    keyPrefix = 'learnix:cache:',
  ) {
    super();
    this.keyPrefix = keyPrefix;
  }

  public async get<Value>(key: string): Promise<Value | undefined> {
    const value = await this.client.get(this.prefixed(key));
    return (value ?? undefined) as Value | undefined;
  }

  /**
   * Batched read used by Keyv `getMany` (and therefore `cacheManager.mget`):
   * one Redis `MGET` instead of one round trip per key. Absent keys resolve to
   * `undefined`, exactly like `get`. Keyv deserializes each row and deletes the
   * expired ones itself, so semantics match the per-key path.
   *
   * MGET requires all keys on one node; the cache client is a standalone
   * connection (not Redis Cluster).
   */
  public async getMany<Value>(keys: string[]): Promise<Array<Value | undefined>> {
    if (keys.length === 0) {
      return [];
    }
    const values = await this.client.mGet(keys.map((key) => this.prefixed(key)));
    return values.map((value) => (value ?? undefined) as Value | undefined);
  }

  public async set(key: string, value: unknown, ttl?: number): Promise<boolean> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (ttl !== undefined && ttl > 0) {
      await this.client.set(this.prefixed(key), serialized, { PX: ttl });
    } else {
      await this.client.set(this.prefixed(key), serialized);
    }

    return true;
  }

  public async delete(key: string): Promise<boolean> {
    return (await this.client.del(this.prefixed(key))) > 0;
  }

  public async clear(): Promise<void> {
    let pending: string[] = [];

    for await (const keys of this.client.scanIterator({
      MATCH: `${this.keyPrefix}*`,
      COUNT: DELETE_BATCH_SIZE,
    })) {
      pending.push(...keys);

      if (pending.length >= DELETE_BATCH_SIZE) {
        await this.client.del(pending);
        pending = [];
      }
    }

    if (pending.length > 0) {
      await this.client.del(pending);
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private prefixed(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}
