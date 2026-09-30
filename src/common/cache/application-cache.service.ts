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
  | 'user_profile'
  | 'marketplace_catalog'
  // W1-C6 (a): anonymous, unsigned public academic catalog reads (T037/T038).
  | 'public_catalog'
  // W1-C6 (b, c): anonymous, caller-independent public gamification reads (T037).
  | 'gamification_public'
  // W1-C7 (a): teacher quiz analytics, owner-scoped (T039).
  | 'teacher_quiz_analytics'
  // W1-C7 (c): student quiz analytics, owner-scoped (T040).
  | 'student_quiz_analytics'
  // W1-C8: reconciliation-warnings snapshot, role-scoped (T041).
  | 'finance_reconciliation';

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
  'marketplace_catalog',
  'public_catalog',
  'gamification_public',
  'teacher_quiz_analytics',
  'student_quiz_analytics',
  'finance_reconciliation',
] as const;

/** One owner's slice of an owner-scoped family (see `invalidateScopes`). */
export interface ApplicationCacheScopeInvalidation {
  family: ApplicationCacheFamily;
  scope: string;
}

export interface ApplicationCacheDescriptor {
  family: ApplicationCacheFamily;
  /**
   * A static route/service name only; never put user or resource IDs here. It is
   * part of the persisted key (hashed), so two endpoints in one family/scope can
   * never collide on identical `parts`.
   */
  endpoint: string;
  /** Defaults to the current single-tenant deployment. Future tenant claims feed this field. */
  tenant?: string | undefined;
  /** Owner/access/role scope. It is hashed in the persisted key. */
  scope: string;
  /**
   * Resource/filter dimensions. They are hashed, never exposed in metrics.
   * Objects are key-sorted and `undefined` properties dropped before hashing, so
   * `{a:1,b:undefined,c:2}` and `{c:2,a:1}` address the same entry. Array order is
   * significant. An explicit `null` is a distinct value from an absent property.
   */
  parts?: readonly unknown[];
  ttlMs: number;
}

/**
 * Canonical form of key parts: plain-object keys sorted recursively and
 * `undefined` properties dropped, so property order and omitted-vs-undefined
 * never fragment the cache. Arrays keep their order; other values (including
 * `Date`, which `JSON.stringify` renders as an ISO string) pass through.
 */
export function normalizeParts(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeParts(item));
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype === Object.prototype || prototype === null) {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) {
          normalized[key] = normalizeParts(entry);
        }
      }
      return normalized;
    }
  }
  return value;
}

/**
 * Versioned cache-aside facade. A generation bump makes old entries
 * unreachable without Redis KEYS/SCAN/wildcard deletion. That means every
 * successful mutation can invalidate safely across replicas while legacy v1
 * entries naturally expire under their existing TTLs.
 *
 * Cached values are JSON round-tripped by the store: a `Date` returned by
 * `compute` is an ISO string on a cache hit (and a `Date` on the miss that
 * computed it). Callers must not depend on `Date`, `Map`, `Set`, `bigint` or
 * class instances surviving a hit; return plain JSON-safe data.
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
    // One batched read (Redis MGET) for the global, family and scope generations;
    // the value read is the second and last command of a cache hit, however many
    // generation levels the key material has.
    const [globalVersion, familyVersion, scopeVersion] = await this.readGenerations([
      this.versionKey(tenant, 'global'),
      this.versionKey(tenant, descriptor.family),
      this.versionKey(tenant, descriptor.family, descriptor.scope),
    ]);
    const key = this.buildKey(descriptor, `${globalVersion}.${familyVersion}.${scopeVersion}`);
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

  /**
   * Invalidate one owner's entries in an owner-scoped family without touching any
   * other owner's entries. `scope` must be the exact string the family's
   * `getOrCompute` callers pass (for example `owner:<userId>`). A caller that is
   * unsure which owners a write affects must use `invalidate([family])` instead.
   */
  public async invalidateScopes(
    scopes: readonly ApplicationCacheScopeInvalidation[],
    tenant = 'default',
  ): Promise<void> {
    await Promise.all(
      scopes.map(async ({ family, scope }) => {
        await this.cacheManager.set(
          this.versionKey(tenant, family, scope),
          randomUUID(),
          86_400_000,
        );
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
  public buildKey(descriptor: ApplicationCacheDescriptor, version = '0.0.0'): string {
    const tenant = descriptor.tenant ?? 'default';
    return [
      'v2',
      `tenant:${this.hash(tenant)}`,
      `scope:${this.hash(descriptor.scope)}`,
      `family:${descriptor.family}`,
      `generation:${version}`,
      `endpoint:${this.hash(descriptor.endpoint)}`,
      `parts:${this.hash(JSON.stringify(normalizeParts(descriptor.parts ?? [])))}`,
    ].join(':');
  }

  /** Reads several generation keys with a single `mget`; an absent generation is `'0'`. */
  private async readGenerations(keys: readonly string[]): Promise<string[]> {
    const versions = await this.cacheManager.mget<string>([...keys]);
    return keys.map((_, index) => versions[index] ?? '0');
  }

  /**
   * Generation key for the global level, a family, or one scope inside a family.
   * The scope is hashed like it is in cache keys, so no raw owner id is persisted.
   */
  private versionKey(
    tenant: string,
    family: ApplicationCacheFamily | 'global',
    scope?: string,
  ): string {
    const base = `v2:cache-generation:tenant:${this.hash(tenant)}:family:${family}`;
    return scope === undefined ? base : `${base}:scope:${this.hash(scope)}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('base64url').slice(0, 22);
  }
}
