import { createHash, randomUUID } from 'node:crypto';

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';

import type { Cache } from 'cache-manager';

import {
  DistributedSingleFlightService,
  type CacheMetricContext,
} from '../../analytics/distributed-single-flight.service';
import { performanceMetrics } from '../../observability/performance-metrics.registry';

/** Cache families are intentionally small, stable, and free of request IDs. */
export type ApplicationCacheFamily =
  | 'admin_dashboard'
  | 'teacher_dashboard'
  | 'student_dashboard'
  | 'lesson_analytics'
  | 'exam_analytics'
  | 'teacher_report'
  | 'student_report'
  | 'platform_report'
  | 'student_profile'
  | 'user_profile';

export const APPLICATION_CACHE_FAMILIES: readonly ApplicationCacheFamily[] = [
  'admin_dashboard',
  'teacher_dashboard',
  'student_dashboard',
  'lesson_analytics',
  'exam_analytics',
  'teacher_report',
  'student_report',
  'platform_report',
  'student_profile',
  'user_profile',
] as const;

export interface ApplicationCacheDescriptor {
  family: ApplicationCacheFamily;
  /** A static route/service name only; never put user or resource IDs here. */
  endpoint: string;
  /** Defaults to the current single-tenant deployment. Future tenant claims feed this field. */
  tenant?: string | undefined;
  /** Owner/access/role scope. It is hashed in the persisted key. */
  scope: string;
  /** Resource/filter dimensions. They are hashed, never exposed in metrics. */
  parts?: readonly unknown[];
  ttlMs: number;
}

/**
 * Versioned cache-aside facade. A generation bump makes old entries
 * unreachable without Redis KEYS/SCAN/wildcard deletion. That means every
 * successful mutation can invalidate safely across replicas while legacy v1
 * entries naturally expire under their existing TTLs.
 */
@Injectable()
export class ApplicationCacheService {
  public constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly singleFlight: DistributedSingleFlightService,
  ) {}

  public async getOrCompute<T>(
    descriptor: ApplicationCacheDescriptor,
    compute: () => Promise<T>,
  ): Promise<T> {
    const tenant = descriptor.tenant ?? 'default';
    const [globalVersion, familyVersion] = await Promise.all([
      this.versionFor(tenant, 'global'),
      this.versionFor(tenant, descriptor.family),
    ]);
    const key = this.buildKey(descriptor, `${globalVersion}.${familyVersion}`);
    const context: CacheMetricContext = {
      family: descriptor.family,
      endpoint: descriptor.endpoint,
    };
    return await this.singleFlight.getOrCompute(key, descriptor.ttlMs, compute, context);
  }

  /** Invalidate exact families by switching generation, never by a key pattern. */
  public async invalidate(
    families: readonly ApplicationCacheFamily[] = APPLICATION_CACHE_FAMILIES,
    tenant = 'default',
  ): Promise<void> {
    await Promise.all(
      families.map(async (family) => {
        await this.cacheManager.set(this.versionKey(tenant, family), randomUUID(), 86_400_000);
        performanceMetrics.recordCache({ family, endpoint: 'invalidation', outcome: 'invalidation' });
      }),
    );
  }

  /** Conservative post-mutation safety net for all create/update/delete/bulk/status routes. */
  public async invalidateAll(tenant = 'default'): Promise<void> {
    await this.cacheManager.set(this.versionKey(tenant, 'global'), randomUUID(), 86_400_000);
    performanceMetrics.recordCache({
      family: 'all',
      endpoint: 'mutation',
      outcome: 'invalidation',
    });
  }

  /** Exposed for deterministic key/isolation tests; no sensitive raw value is emitted. */
  public buildKey(descriptor: ApplicationCacheDescriptor, version = '0.0'): string {
    const tenant = descriptor.tenant ?? 'default';
    return [
      'v2',
      `tenant:${this.hash(tenant)}`,
      `scope:${this.hash(descriptor.scope)}`,
      `family:${descriptor.family}`,
      `generation:${version}`,
      `parts:${this.hash(JSON.stringify(descriptor.parts ?? []))}`,
    ].join(':');
  }

  private async versionFor(tenant: string, family: ApplicationCacheFamily | 'global'): Promise<string> {
    return (await this.cacheManager.get<string>(this.versionKey(tenant, family))) ?? '0';
  }

  private versionKey(tenant: string, family: ApplicationCacheFamily | 'global'): string {
    return `v2:cache-generation:tenant:${this.hash(tenant)}:family:${family}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('base64url').slice(0, 22);
  }
}
