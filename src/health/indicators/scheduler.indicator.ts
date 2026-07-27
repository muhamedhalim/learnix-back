import { Injectable } from '@nestjs/common';

import { healthCollectionState } from '../health-collection.state';
import type { HealthIndicator } from '../health-indicator.interface';
import type { HealthComponentResult } from '../health.types';
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

@Injectable()
export class SchedulerHealthIndicator implements HealthIndicator {
  public readonly id = 'scheduled-jobs';

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const completedAt = healthCollectionState.lastCompletedAt;
    const ageSeconds = completedAt === null ? null : (Date.now() - completedAt.getTime()) / 1000;
    const status =
      completedAt === null
        ? 'unknown'
        : ageSeconds !== null && ageSeconds > 300
          ? 'degraded'
          : ageSeconds !== null && ageSeconds > 150
            ? 'warning'
            : 'healthy';
    return componentResult({
      id: this.id,
      name: 'Scheduled jobs',
      category: 'scheduler',
      status,
      startedAt,
      message:
        status === 'healthy'
          ? 'The health collector scheduler heartbeat is current.'
          : completedAt === null
            ? 'Scheduler history is not available until the first collection completes.'
            : 'The health collector heartbeat is late.',
      metadata: {
        schedulerLoaded: true,
        detectedJobs: DETECTED_SCHEDULES,
        lastHealthCollectionStartedAt: healthCollectionState.lastStartedAt?.toISOString() ?? null,
        lastHealthCollectionCompletedAt: completedAt?.toISOString() ?? null,
        lastHealthCollectionFailedAt: healthCollectionState.lastFailedAt?.toISOString() ?? null,
        collectionRunning: healthCollectionState.running,
        missedHealthCollections:
          ageSeconds === null ? null : Math.max(0, Math.floor(ageSeconds / 60) - 1),
      },
      warnings:
        completedAt === null
          ? ['Existing business cron jobs do not yet emit individual persisted heartbeats.']
          : [],
      recommendation:
        status === 'healthy'
          ? null
          : 'Verify the scheduler process is running and inspect the last collection error.',
      dependencies: ['backend-api', 'postgresql'],
      critical: true,
    });
  }
}
