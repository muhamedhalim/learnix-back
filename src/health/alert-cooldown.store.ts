import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import Redis from 'ioredis';

import { resolveRedisUrl } from '../common/utils/redis-connection.util';
import { namespacedPrefix } from '../common/utils/redis-namespace.util';

const MAX_LOCAL_KEYS = 500;

/**
 * Repeat-suppression for external operational alerts, shared by every replica.
 *
 * `claim` is an atomic "may I deliver this incident now?": with Redis it is a single `SET NX PX`,
 * so N replicas that notice the same incident in the same second send ONE email, not N. Without
 * Redis (local development) or when Redis misbehaves it degrades to a per-process map, which is the
 * previous behaviour. Failing open is deliberate: an alert that might be duplicated beats one that
 * is silently dropped.
 */
@Injectable()
export class AlertCooldownStore implements OnModuleDestroy {
  private readonly logger = new Logger(AlertCooldownStore.name);
  private readonly local = new Map<string, number>();
  private redis: Redis | null = null;
  private readonly prefix: string;

  constructor(private readonly config: ConfigService) {
    this.prefix = `${namespacedPrefix((key) => this.config.get<string>(key))}alert-cooldown:`;
  }

  private client(): Redis | null {
    if (this.redis !== null) return this.redis;
    const url = resolveRedisUrl((key) => this.config.get<string>(key));
    if (url === undefined) return null;
    const client = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 });
    client.on('error', () => undefined); // surfaced through the failing command, handled in claim()
    this.redis = client;
    return client;
  }

  /** True when the caller owns delivery of this incident for the next `ttlMs`. */
  public async claim(key: string, ttlMs: number): Promise<boolean> {
    if (ttlMs <= 0) return true;
    const redis = this.client();
    if (redis !== null) {
      try {
        const result = await redis.set(`${this.prefix}${key}`, '1', 'PX', ttlMs, 'NX');
        return result === 'OK';
      } catch (error) {
        this.logger.warn(`Alert cooldown via Redis failed, using local state: ${(error as Error).message}`);
      }
    }
    return this.claimLocal(key, ttlMs);
  }

  /** Give the claim back when nothing could be delivered, so the next occurrence may try again. */
  public async release(key: string): Promise<void> {
    this.local.delete(key);
    const redis = this.client();
    if (redis === null) return;
    try {
      await redis.del(`${this.prefix}${key}`);
    } catch {
      // Best effort: the claim simply expires on its own.
    }
  }

  private claimLocal(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const last = this.local.get(key);
    if (last !== undefined && now - last < ttlMs) return false;
    if (this.local.size >= MAX_LOCAL_KEYS) {
      for (const [existing, at] of this.local) if (now - at >= ttlMs) this.local.delete(existing);
      if (this.local.size >= MAX_LOCAL_KEYS) {
        const oldest = this.local.keys().next();
        if (!oldest.done) this.local.delete(oldest.value);
      }
    }
    this.local.set(key, now);
    return true;
  }

  public onModuleDestroy(): void {
    this.redis?.disconnect();
    this.redis = null;
  }
}
