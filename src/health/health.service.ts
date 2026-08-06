import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';

import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { resolveRedisUrl } from '../common/utils/redis-connection.util';
import { withHealthTimeout } from './health-timeout.util';

/**
 * Small public probe facade. Detailed health logic lives in the orchestrator
 * and component indicators; this class keeps the public liveness contract
 * deliberately minimal.
 */
@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  public getPublicLiveness(): { status: 'healthy'; timestamp: string } {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  }

  /**
   * Liveness vs readiness vs degraded, as this codebase actually implements
   * the distinction (Phase 2 audit, STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md
   * §28.9):
   *
   *   - LIVENESS  (`getPublicLiveness` / `GET /health`) — "is the process up
   *     at all". Always `healthy` if this code runs; no dependency check.
   *   - READINESS (this method / `GET /health/readiness`) — "should traffic
   *     be routed here". Checks the connections nothing works without:
   *     Postgres and, when configured, Redis. Either one down → `not_ready`.
   *   - DEGRADED  (`HealthOrchestratorService` / `GET /health/all`,
   *     admin-only) — richer per-component status (`healthy` / `warning` /
   *     `degraded` / `down`) for every indicator, used for diagnosis rather
   *     than routing decisions. A component can be `degraded` (e.g. Redis
   *     memory pressure) without the service being `not_ready`.
   *
   * Before this method also checked Redis, a Redis outage that happened
   * *after* boot (network blip, Redis restart) was invisible to this probe —
   * Redis is mandatory at boot (`app.module.ts` refuses to start without it
   * in production) but nothing re-verified it afterwards. Redis backs the
   * cache, the rate limiter, and every BullMQ queue, so it is now checked
   * here too.
   */
  public async getReadiness(): Promise<{
    status: 'ready' | 'not_ready';
    timestamp: string;
  }> {
    let status: 'ready' | 'not_ready' = 'not_ready';

    try {
      await withHealthTimeout('readiness.database', this.dataSource.query('SELECT 1'), 2_000);
      await this.checkRedisReady();
      status = 'ready';
    } catch {
      // Public probes deliberately return no infrastructure or failure details.
    }

    return {
      status,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * No-ops when Redis isn't configured at all — the same "optional outside
   * production" contract every other Redis consumer in this codebase
   * honours (`app.module.ts`, `queues.module.ts`). A brand-new, short-lived
   * connection is used and always disconnected, so a readiness probe firing
   * every few seconds never accumulates idle Redis connections.
   */
  private async checkRedisReady(): Promise<void> {
    const redisUrl = resolveRedisUrl((key) => this.config.get<string>(key));
    if (redisUrl === undefined) return;

    const client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      await withHealthTimeout(
        'readiness.redis',
        client.connect().then(() => client.ping()),
        2_000,
      );
    } finally {
      client.disconnect();
    }
  }
}
