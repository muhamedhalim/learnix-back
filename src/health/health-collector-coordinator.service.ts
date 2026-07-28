import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import Redis from 'ioredis';

import { resolveRedisUrl } from '../common/utils/redis-connection.util';
import { healthCollectionState } from './health-collection.state';
import { sanitiseMessage } from './health-sanitizer.util';

const COLLECTION_VERSION = 'health-v2';
const DEFAULT_CADENCE_SECONDS = 60;
const DEFAULT_LOCK_TTL_MS = 120_000;
const STATE_KEY = 'learnix:health:collector:state:v2';
const HEARTBEAT_KEY = 'learnix:health:collector:heartbeat:v2';
const LOCK_PREFIX = 'learnix:health:collector:lock:v2';
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type CollectorSkipReason = 'process_role' | 'distributed_lock' | 'coordination_unavailable';

export interface CollectorPersistentState {
  collectionVersion: string;
  instanceId: string;
  processRole: string;
  cadenceSeconds: number;
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  skippedAt: string | null;
  durationMs: number | null;
  lastErrorCategory: string | null;
  lastSkipReason: CollectorSkipReason | null;
}

export interface CollectorLease {
  purpose: 'collection' | 'aggregation';
  token: string;
  release(): Promise<void>;
}

@Injectable()
export class HealthCollectorCoordinatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthCollectorCoordinatorService.name);
  private readonly instanceId: string;
  private readonly processRole: string;
  private readonly designatedRole: string;
  private readonly cadenceSeconds: number;
  private readonly lockTtlMs: number;
  private redis: Redis | null = null;
  private localLock: string | null = null;
  private cachedState: CollectorPersistentState | null = null;
  private readonly renewals = new Map<string, NodeJS.Timeout>();

  public constructor(private readonly config: ConfigService) {
    this.instanceId =
      this.config.get<string>('INSTANCE_ID') ||
      this.config.get<string>('RAILWAY_REPLICA_ID') ||
      this.config.get<string>('HOSTNAME') ||
      `${hostname()}:${process.pid.toString()}`;
    this.processRole = this.config.get<string>('PROCESS_ROLE') || 'api';
    this.designatedRole = this.config.get<string>('HEALTH_COLLECTOR_PROCESS_ROLE') || 'api';
    this.cadenceSeconds = this.positiveNumber(
      this.config.get<string>('HEALTH_COLLECTOR_CADENCE_SECONDS'),
      DEFAULT_CADENCE_SECONDS,
    );
    this.lockTtlMs = Math.max(
      this.cadenceSeconds * 1_000,
      this.positiveNumber(
        this.config.get<string>('HEALTH_COLLECTOR_LOCK_TTL_MS'),
        DEFAULT_LOCK_TTL_MS,
      ),
    );
    healthCollectionState.collectionVersion = COLLECTION_VERSION;
    healthCollectionState.instanceId = this.instanceId;
    healthCollectionState.processRole = this.processRole;
  }

  public async onModuleInit(): Promise<void> {
    const redisUrl = resolveRedisUrl((key) => this.config.get<string>(key));
    if (!redisUrl) {
      this.logger.warn(
        'Redis is not configured; health collection is single-process only outside production.',
      );
      return;
    }
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: this.config.get<string>('NODE_ENV') === 'production' ? undefined : () => null,
    });
    client.on('error', (error: Error) => {
      this.logger.warn(`Health collector Redis coordination error: ${sanitiseMessage(error)}`);
    });
    try {
      await client.connect();
      this.redis = client;
      this.cachedState = await this.readRemoteState();
    } catch (error) {
      this.logger.error(
        `Health collector Redis coordination unavailable: ${sanitiseMessage(error)}`,
      );
      client.disconnect(false);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    for (const renewal of this.renewals.values()) clearInterval(renewal);
    this.renewals.clear();
    if (this.redis !== null) {
      this.redis.disconnect(false);
      this.redis = null;
    }
  }

  public isDesignatedProcess(): boolean {
    return this.processRole === this.designatedRole;
  }

  public getIdentity(): {
    instanceId: string;
    processRole: string;
    designatedRole: string;
    collectionVersion: string;
    cadenceSeconds: number;
    lockTtlMs: number;
    coordinated: boolean;
  } {
    return {
      instanceId: this.instanceId,
      processRole: this.processRole,
      designatedRole: this.designatedRole,
      collectionVersion: COLLECTION_VERSION,
      cadenceSeconds: this.cadenceSeconds,
      lockTtlMs: this.lockTtlMs,
      coordinated: this.redis?.status === 'ready',
    };
  }

  public async acquireLease(
    purpose: CollectorLease['purpose'],
  ): Promise<CollectorLease | CollectorSkipReason> {
    if (!this.isDesignatedProcess()) return 'process_role';
    const token = `${this.instanceId}:${randomUUID()}`;
    const lockKey = `${LOCK_PREFIX}:${purpose}`;

    if (this.redis?.status === 'ready') {
      const acquired = await this.redis.set(lockKey, token, 'PX', this.lockTtlMs, 'NX');
      if (acquired !== 'OK') return 'distributed_lock';
    } else {
      if (this.config.get<string>('NODE_ENV') === 'production') {
        return 'coordination_unavailable';
      }
      if (this.localLock !== null) return 'distributed_lock';
      this.localLock = token;
    }

    const renewal = setInterval(
      () => {
        void this.renew(lockKey, token);
      },
      Math.max(1_000, Math.floor(this.lockTtlMs / 3)),
    );
    renewal.unref();
    this.renewals.set(token, renewal);

    return {
      purpose,
      token,
      release: async () => {
        const activeRenewal = this.renewals.get(token);
        if (activeRenewal !== undefined) clearInterval(activeRenewal);
        this.renewals.delete(token);
        if (this.redis?.status === 'ready') {
          await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token).catch((error: unknown) => {
            this.logger.warn(`Health collector lock release failed: ${sanitiseMessage(error)}`);
          });
        } else if (this.localLock === token) {
          this.localLock = null;
        }
      },
    };
  }

  public async recordStarted(startedAt: Date): Promise<void> {
    const prior = (await this.readState()) ?? this.initialState();
    this.cachedState = {
      ...prior,
      collectionVersion: COLLECTION_VERSION,
      instanceId: this.instanceId,
      processRole: this.processRole,
      cadenceSeconds: this.cadenceSeconds,
      running: true,
      startedAt: startedAt.toISOString(),
      lastSkipReason: null,
    };
    healthCollectionState.running = true;
    healthCollectionState.lastStartedAt = startedAt;
    healthCollectionState.lastSkipReason = null;
    await this.persistState();
  }

  public async recordCompleted(startedAt: Date, completedAt: Date): Promise<void> {
    const state = this.cachedState ?? this.initialState();
    this.cachedState = {
      ...state,
      running: false,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      lastErrorCategory: null,
      lastSkipReason: null,
    };
    healthCollectionState.running = false;
    healthCollectionState.lastCompletedAt = completedAt;
    healthCollectionState.lastDurationMs = this.cachedState.durationMs;
    healthCollectionState.lastErrorCategory = null;
    await this.persistState(true);
  }

  public async recordFailed(startedAt: Date, failedAt: Date, errorCategory: string): Promise<void> {
    const state = this.cachedState ?? this.initialState();
    this.cachedState = {
      ...state,
      running: false,
      failedAt: failedAt.toISOString(),
      durationMs: failedAt.getTime() - startedAt.getTime(),
      lastErrorCategory: errorCategory,
      lastSkipReason: null,
    };
    healthCollectionState.running = false;
    healthCollectionState.lastFailedAt = failedAt;
    healthCollectionState.lastDurationMs = this.cachedState.durationMs;
    healthCollectionState.lastErrorCategory = errorCategory;
    await this.persistState();
  }

  public async recordSkipped(reason: CollectorSkipReason, skippedAt = new Date()): Promise<void> {
    const prior = (await this.readState()) ?? this.initialState();
    this.cachedState = {
      ...prior,
      skippedAt: skippedAt.toISOString(),
      lastSkipReason: reason,
    };
    healthCollectionState.lastSkippedAt = skippedAt;
    healthCollectionState.lastSkipReason = reason;
    await this.persistState();
  }

  public async readState(): Promise<CollectorPersistentState | null> {
    const remote = await this.readRemoteState();
    if (remote !== null) this.cachedState = remote;
    return remote ?? this.cachedState;
  }

  private async renew(lockKey: string, token: string): Promise<void> {
    if (this.redis?.status !== 'ready') return;
    try {
      const renewed = await this.redis.eval(
        RENEW_SCRIPT,
        1,
        lockKey,
        token,
        this.lockTtlMs.toString(),
      );
      if (Number(renewed) !== 1) {
        this.logger.warn('Health collector distributed lock ownership was lost.');
      }
    } catch (error) {
      this.logger.warn(`Health collector lock renewal failed: ${sanitiseMessage(error)}`);
    }
  }

  private async persistState(successfulHeartbeat = false): Promise<void> {
    if (this.cachedState === null || this.redis?.status !== 'ready') return;
    const serialized = JSON.stringify(this.cachedState);
    try {
      await this.redis.set(STATE_KEY, serialized);
      if (successfulHeartbeat) await this.redis.set(HEARTBEAT_KEY, serialized);
    } catch (error) {
      this.logger.warn(`Health collector state persistence failed: ${sanitiseMessage(error)}`);
    }
  }

  private async readRemoteState(): Promise<CollectorPersistentState | null> {
    if (this.redis?.status !== 'ready') return null;
    try {
      const value = await this.redis.get(STATE_KEY);
      if (value === null) return null;
      return this.parseState(value);
    } catch (error) {
      this.logger.warn(`Health collector state read failed: ${sanitiseMessage(error)}`);
      return null;
    }
  }

  private parseState(value: string): CollectorPersistentState | null {
    try {
      const parsed = JSON.parse(value) as Partial<CollectorPersistentState>;
      if (
        typeof parsed.instanceId !== 'string' ||
        typeof parsed.processRole !== 'string' ||
        typeof parsed.cadenceSeconds !== 'number'
      ) {
        return null;
      }
      return {
        ...this.initialState(),
        ...parsed,
      };
    } catch {
      return null;
    }
  }

  private initialState(): CollectorPersistentState {
    return {
      collectionVersion: COLLECTION_VERSION,
      instanceId: this.instanceId,
      processRole: this.processRole,
      cadenceSeconds: this.cadenceSeconds,
      running: false,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      skippedAt: null,
      durationMs: null,
      lastErrorCategory: null,
      lastSkipReason: null,
    };
  }

  private positiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
