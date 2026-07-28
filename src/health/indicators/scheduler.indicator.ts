import { Injectable } from '@nestjs/common';

import { HealthCollectorCoordinatorService } from '../health-collector-coordinator.service';
import type { HealthIndicator } from '../health-indicator.interface';
import type { HealthComponentResult, HealthStatus } from '../health.types';
import { componentResult } from './indicator-result.util';

const DETECTED_SCHEDULES = [
  { id: 'health-collection', schedule: 'every minute' },
  { id: 'package-publishing', schedule: 'every 5 minutes' },
  { id: 'lesson-publishing', schedule: 'every 30 minutes' },
  { id: 'payment-expiry', schedule: 'every minute' },
  { id: 'payment-reconciliation', schedule: 'every 30 minutes' },
  { id: 'session-cleanup', schedule: 'daily at 03:00' },
  { id: 'upload-cleanup', schedule: 'weekly Sunday at 02:00' },
] as const;

export function classifyCollectorHeartbeat(input: {
  completedAt: string | null;
  cadenceSeconds: number;
  processUptimeSeconds: number;
  now?: number;
}): { status: HealthStatus; ageSeconds: number | null; reasonCode: string } {
  if (input.completedAt === null) {
    return {
      status: input.processUptimeSeconds < input.cadenceSeconds * 3 ? 'unknown' : 'degraded',
      ageSeconds: null,
      reasonCode:
        input.processUptimeSeconds < input.cadenceSeconds * 3
          ? 'COLLECTOR_STARTUP_GRACE'
          : 'COLLECTOR_HEARTBEAT_MISSING',
    };
  }
  const timestamp = Date.parse(input.completedAt);
  if (!Number.isFinite(timestamp)) {
    return {
      status: 'unknown',
      ageSeconds: null,
      reasonCode: 'COLLECTOR_HEARTBEAT_INVALID',
    };
  }
  const ageSeconds = Math.max(0, ((input.now ?? Date.now()) - timestamp) / 1_000);
  if (ageSeconds > input.cadenceSeconds * 5) {
    return { status: 'degraded', ageSeconds, reasonCode: 'COLLECTOR_HEARTBEAT_STALE' };
  }
  if (ageSeconds > input.cadenceSeconds * 2.5) {
    return { status: 'warning', ageSeconds, reasonCode: 'COLLECTOR_HEARTBEAT_LATE' };
  }
  return { status: 'healthy', ageSeconds, reasonCode: 'COLLECTOR_HEARTBEAT_CURRENT' };
}

@Injectable()
export class SchedulerHealthIndicator implements HealthIndicator {
  public readonly id = 'scheduled-jobs';

  public constructor(private readonly coordinator: HealthCollectorCoordinatorService) {}

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const identity = this.coordinator.getIdentity();
    const state = await this.coordinator.readState();
    const heartbeat = classifyCollectorHeartbeat({
      completedAt: state?.completedAt ?? null,
      cadenceSeconds: state?.cadenceSeconds ?? identity.cadenceSeconds,
      processUptimeSeconds: process.uptime(),
    });
    const status = heartbeat.status;
    const skippedForLock = state?.lastSkipReason === 'distributed_lock';
    return componentResult({
      id: this.id,
      name: 'Scheduled jobs',
      category: 'scheduler',
      status,
      startedAt,
      message:
        status === 'healthy'
          ? 'The distributed health collector heartbeat is current.'
          : status === 'unknown'
            ? 'The collector is in startup grace or no valid heartbeat has been observed.'
            : 'The distributed health collector heartbeat is late or stale.',
      metadata: {
        schedulerLoaded: true,
        detectedJobs: DETECTED_SCHEDULES,
        collectionVersion: state?.collectionVersion ?? identity.collectionVersion,
        instanceId: state?.instanceId ?? identity.instanceId,
        processRole: state?.processRole ?? identity.processRole,
        designatedProcessRole: identity.designatedRole,
        distributedLock: identity.coordinated,
        lockTtlMs: identity.lockTtlMs,
        cadenceSeconds: state?.cadenceSeconds ?? identity.cadenceSeconds,
        staleWarningThresholdSeconds: identity.cadenceSeconds * 2.5,
        staleDegradedThresholdSeconds: identity.cadenceSeconds * 5,
        lastHealthCollectionStartedAt: state?.startedAt ?? null,
        lastHealthCollectionCompletedAt: state?.completedAt ?? null,
        lastHealthCollectionFailedAt: state?.failedAt ?? null,
        lastHealthCollectionSkippedAt: state?.skippedAt ?? null,
        lastDurationMs: state?.durationMs ?? null,
        lastErrorCategory: state?.lastErrorCategory ?? null,
        lastSkipReason: state?.lastSkipReason ?? null,
        collectionRunning: state?.running ?? false,
        heartbeatAgeSeconds:
          heartbeat.ageSeconds === null ? null : Math.round(heartbeat.ageSeconds),
        missedHealthCollections:
          heartbeat.ageSeconds === null
            ? null
            : Math.max(
                0,
                Math.floor(
                  heartbeat.ageSeconds / (state?.cadenceSeconds ?? identity.cadenceSeconds),
                ) - 1,
              ),
      },
      warnings: [
        ...(status === 'unknown'
          ? [
              'A deployment restart is within startup grace; this is not counted as permanent failure.',
            ]
          : []),
        ...(skippedForLock
          ? ['This replica skipped its last run because another replica held the lock.']
          : []),
      ],
      errorCode: status === 'healthy' ? null : heartbeat.reasonCode,
      recommendation:
        status === 'healthy' || status === 'unknown'
          ? null
          : 'Verify the designated scheduler process, Redis lock coordination, and the last sanitized error category.',
      dependencies: ['redis', 'postgresql'],
      dependencyTypes: { redis: 'direct', postgresql: 'operational' },
      importance: 'important',
      required: true,
    });
  }
}
