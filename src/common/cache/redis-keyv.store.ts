import { EventEmitter } from 'node:events';

import type { RedisClientType } from 'redis';

const CACHE_KEY_PREFIX = 'learnix:cache:';
const DELETE_BATCH_SIZE = 100;

/**
 * Minimal Keyv-compatible adapter for the node-redis client already used by
 * the application. Nest CacheManager v3 wraps this adapter in Keyv and owns
 * its lifecycle through disconnect().
 */
export class RedisKeyvStore extends EventEmitter {
  public readonly opts: Record<string, never> = {};

  public constructor(private readonly client: RedisClientType) {
    super();
  }

  public async get<Value>(key: string): Promise<Value | undefined> {
    const value = await this.client.get(this.prefixed(key));
    return (value ?? undefined) as Value | undefined;
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
      MATCH: `${CACHE_KEY_PREFIX}*`,
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
    return `${CACHE_KEY_PREFIX}${key}`;
  }
}
