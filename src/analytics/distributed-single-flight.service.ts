import { randomUUID } from 'node:crypto';

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Cache } from 'cache-manager';
import { createClient } from 'redis';

const CACHE_MISS = Symbol('CACHE_MISS');

@Injectable()
export class DistributedSingleFlightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DistributedSingleFlightService.name);
  private readonly localFlights = new Map<string, Promise<unknown>>();
  private readonly lockTtlMs: number;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private redisClient: ReturnType<typeof createClient> | null = null;

  public constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
  ) {
    this.lockTtlMs = this.positiveNumber(
      this.configService.get<string>('CACHE_LOCK_TTL_MS'),
      10_000,
    );
    this.waitTimeoutMs = this.positiveNumber(
      this.configService.get<string>('CACHE_LOCK_WAIT_TIMEOUT_MS'),
      3_000,
    );
    this.pollIntervalMs = this.positiveNumber(
      this.configService.get<string>('CACHE_LOCK_POLL_INTERVAL_MS'),
      20,
    );
  }

  public async onModuleInit(): Promise<void> {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    const redisHost = this.configService.get<string>('REDIS_HOST');
    const redisPassword = this.configService.get<string>('REDIS_PASSWORD') || undefined;
    if (!redisUrl && !redisHost) {
      this.logger.warn('Redis is not configured; distributed cache locking is unavailable');
      return;
    }

    const client = createClient(
      redisUrl
        ? { url: redisUrl }
        : {
            socket: {
              host: redisHost!,
              port: this.configService.get<number>('REDIS_PORT') ?? 6379,
            },
            ...(redisPassword ? { password: redisPassword } : {}),
          },
    );
    client.on('error', (error: Error) => {
      this.logger.error(`Redis lock client error: ${error.message}`);
    });

    try {
      await client.connect();
      this.redisClient = client;
    } catch (error) {
      this.logger.error(
        `Redis lock client unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      await client.disconnect().catch(() => undefined);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
  }

  public async getOrCompute<T>(
    cacheKey: string,
    ttlMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.getCached<T>(cacheKey);
    if (cached !== CACHE_MISS) return cached;

    const activeFlight = this.localFlights.get(cacheKey) as Promise<T> | undefined;
    if (activeFlight) return await activeFlight;

    const flight = this.coordinateAcrossReplicas(cacheKey, ttlMs, compute);
    this.localFlights.set(cacheKey, flight);

    try {
      return await flight;
    } finally {
      if (this.localFlights.get(cacheKey) === flight) {
        this.localFlights.delete(cacheKey);
      }
    }
  }

  private async coordinateAcrossReplicas<T>(
    cacheKey: string,
    ttlMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (!this.redisClient?.isReady) {
      return await this.computeAndCache(cacheKey, ttlMs, compute);
    }

    const lockKey = `cache-lock:${cacheKey}`;
    const deadline = Date.now() + this.waitTimeoutMs;

    do {
      const token = randomUUID();
      if (await this.acquireLock(lockKey, token)) {
        return await this.computeAsLockOwner(lockKey, token, cacheKey, ttlMs, compute);
      }

      const cached = await this.getCached<T>(cacheKey);
      if (cached !== CACHE_MISS) return cached;

      await this.delay(this.pollIntervalMs);
    } while (Date.now() < deadline);

    this.logger.warn(
      `Timed out waiting ${this.waitTimeoutMs.toString()}ms for ${lockKey}; computing locally as availability fallback`,
    );
    return await this.computeAndCache(cacheKey, ttlMs, compute);
  }

  private async computeAsLockOwner<T>(
    lockKey: string,
    token: string,
    cacheKey: string,
    ttlMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    try {
      const cached = await this.getCached<T>(cacheKey);
      if (cached !== CACHE_MISS) return cached;
      return await this.computeAndCache(cacheKey, ttlMs, compute);
    } finally {
      await this.releaseLock(lockKey, token);
    }
  }

  private async computeAndCache<T>(
    cacheKey: string,
    ttlMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const result = await compute();
    await this.cacheManager.set(cacheKey, result, ttlMs);
    return result;
  }

  private async getCached<T>(cacheKey: string): Promise<T | typeof CACHE_MISS> {
    const value = await this.cacheManager.get<T>(cacheKey);
    return value === undefined || value === null ? CACHE_MISS : value;
  }

  private async acquireLock(lockKey: string, token: string): Promise<boolean> {
    const result = await this.redisClient!.set(lockKey, token, {
      NX: true,
      PX: this.lockTtlMs,
    });
    return result === 'OK';
  }

  private async releaseLock(lockKey: string, token: string): Promise<void> {
    if (!this.redisClient?.isReady) return;

    await this.redisClient.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1]
       then return redis.call("DEL", KEYS[1])
       else return 0 end`,
      {
        keys: [lockKey],
        arguments: [token],
      },
    );
  }

  private positiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
