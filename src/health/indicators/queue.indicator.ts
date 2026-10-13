import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Job, Queue } from 'bullmq';

import { standaloneQueueOptions } from '../../queues/queue-options.util';
import { QUEUE_NAMES } from '../../queues/queues.constants';
import type { HealthIndicator } from '../health-indicator.interface';
import { errorCode, sanitiseMessage } from '../health-sanitizer.util';
import { withHealthTimeout } from '../health-timeout.util';
import type { HealthComponentResult, HealthDependencyType, HealthStatus } from '../health.types';
import { componentResult } from './indicator-result.util';

const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES);

export const QUEUE_HEALTH_THRESHOLDS = {
  backlogWarning: 100,
  backlogDegraded: 1_000,
  oldestWarningSeconds: 600,
  oldestDegradedSeconds: 3_600,
  failureRateMinimumJobs: 20,
  failureRateWarningPercent: 5,
  failureRateDegradedPercent: 20,
  retryLoopWarningCount: 10,
} as const;

export interface QueueHealthEvidence {
  connected?: boolean;
  backlog: number;
  oldestPendingAgeSeconds: number | null;
  workerConnected: boolean | null;
  failed: number;
  completed: number;
  stalled: number;
  retryLoops: number;
  paused: boolean;
  isDeadLetterQueue: boolean;
}

export function classifyQueueHealth(evidence: QueueHealthEvidence): {
  status: HealthStatus;
  reasonCode: string | null;
} {
  if (evidence.connected === false) {
    return { status: 'down', reasonCode: 'QUEUE_REDIS_UNAVAILABLE' };
  }
  if (evidence.isDeadLetterQueue) {
    return evidence.backlog > 0
      ? { status: 'warning', reasonCode: 'QUEUE_DLQ_HAS_JOBS' }
      : { status: 'healthy', reasonCode: null };
  }
  const totalFinished = evidence.completed + evidence.failed;
  const failureRate = totalFinished === 0 ? 0 : (evidence.failed / totalFinished) * 100;
  if (evidence.backlog > 0 && evidence.workerConnected === false) {
    return { status: 'degraded', reasonCode: 'QUEUE_WORKER_MISSING' };
  }
  if (evidence.stalled > 0) {
    return { status: 'degraded', reasonCode: 'QUEUE_STALLED_JOBS' };
  }
  if (
    evidence.backlog >= QUEUE_HEALTH_THRESHOLDS.backlogDegraded ||
    (evidence.oldestPendingAgeSeconds ?? 0) >= QUEUE_HEALTH_THRESHOLDS.oldestDegradedSeconds ||
    (totalFinished >= QUEUE_HEALTH_THRESHOLDS.failureRateMinimumJobs &&
      failureRate >= QUEUE_HEALTH_THRESHOLDS.failureRateDegradedPercent)
  ) {
    return { status: 'degraded', reasonCode: 'QUEUE_CAPACITY_DEGRADED' };
  }
  if (
    evidence.paused ||
    evidence.backlog >= QUEUE_HEALTH_THRESHOLDS.backlogWarning ||
    (evidence.oldestPendingAgeSeconds ?? 0) >= QUEUE_HEALTH_THRESHOLDS.oldestWarningSeconds ||
    (totalFinished >= QUEUE_HEALTH_THRESHOLDS.failureRateMinimumJobs &&
      failureRate >= QUEUE_HEALTH_THRESHOLDS.failureRateWarningPercent) ||
    evidence.retryLoops >= QUEUE_HEALTH_THRESHOLDS.retryLoopWarningCount
  ) {
    return { status: 'warning', reasonCode: 'QUEUE_THRESHOLD_WARNING' };
  }
  return { status: 'healthy', reasonCode: null };
}

@Injectable()
export class QueueHealthIndicator implements HealthIndicator {
  public readonly id = 'background-queues';

  public constructor(private readonly config: ConfigService) {}

  public async check(): Promise<HealthComponentResult[]> {
    const startedAt = Date.now();
    const queueOptions = standaloneQueueOptions((key) => this.config.get<string>(key));
    if (!queueOptions) {
      return [
        componentResult({
          id: this.id,
          name: 'Background queues',
          category: 'queue',
          status:
            this.config.get<string>('NODE_ENV') === 'production' ? 'misconfigured' : 'disabled',
          startedAt,
          message: 'BullMQ is disabled because Redis is not configured.',
          metadata: { configured: false, queueCount: ALL_QUEUE_NAMES.length },
          errorCode: 'QUEUES_DISABLED',
          recommendation:
            'Configure Redis and start the required BullMQ workers before enabling background workloads.',
          dependencies: ['redis'],
          dependencyTypes: { redis: 'direct' },
          importance: 'important',
          required: this.config.get<string>('NODE_ENV') === 'production',
        }),
      ];
    }

    const queues = ALL_QUEUE_NAMES.map((name) => new Queue(name, queueOptions));
    try {
      return await withHealthTimeout(
        this.id,
        Promise.all(queues.map(async (queue) => await this.checkQueue(queue))),
        12_000,
      );
    } catch (error) {
      return [
        componentResult({
          id: this.id,
          name: 'Background queues',
          category: 'queue',
          status: 'down',
          startedAt,
          message: sanitiseMessage(error),
          metadata: { configured: true, connected: false, queueCount: ALL_QUEUE_NAMES.length },
          errorCode: errorCode(error, 'QUEUE_REDIS_UNAVAILABLE'),
          recommendation: 'Restore Redis connectivity before inspecting individual queue state.',
          dependencies: ['redis'],
          dependencyTypes: { redis: 'direct' },
          importance: 'important',
          required: true,
        }),
      ];
    } finally {
      await Promise.allSettled(queues.map(async (queue) => await queue.close()));
    }
  }

  private async checkQueue(queue: Queue): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const [counts, pendingJobs, activeJobs, completedJobs, failedJobs, workers] = await Promise.all(
      [
        queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'completed',
          'failed',
          'prioritized',
          'paused',
        ),
        queue.getJobs(['waiting', 'prioritized', 'delayed'], 0, 99, true),
        queue.getJobs('active', 0, 99, true),
        queue.getJobs('completed', 0, 99, false),
        queue.getJobs('failed', 0, 99, false),
        queue.getWorkers().catch(() => null),
      ],
    );
    const waiting = (counts['waiting'] ?? 0) + (counts['prioritized'] ?? 0);
    const delayed = counts['delayed'] ?? 0;
    const active = counts['active'] ?? 0;
    const completed = counts['completed'] ?? 0;
    const failed = counts['failed'] ?? 0;
    const backlog = waiting + delayed;
    const oldestPending = this.oldest(pendingJobs, (job) => job.timestamp);
    const oldestActive = this.oldest(activeJobs, (job) => job.processedOn ?? job.timestamp);
    const now = Date.now();
    const oldestPendingAgeSeconds =
      oldestPending === null ? null : Math.max(0, (now - oldestPending) / 1_000);
    const oldestActiveAgeSeconds =
      oldestActive === null ? null : Math.max(0, (now - oldestActive) / 1_000);
    const stalled = failedJobs.filter((job) =>
      (job.failedReason ?? '').toLowerCase().includes('stalled'),
    ).length;
    const retryLoops = [...pendingJobs, ...activeJobs, ...failedJobs].filter(
      (job) => job.attemptsMade > 1,
    ).length;
    const workerConnected = workers === null ? null : workers.length > 0;
    const concurrency =
      workers === null
        ? null
        : workers.reduce((sum, worker) => sum + Number(worker['concurrency'] ?? 0), 0);
    const completedRecently = completedJobs.filter(
      (job) => (job.finishedOn ?? 0) >= now - 5 * 60_000,
    );
    const durations = completedJobs
      .map((job) => (job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null))
      .filter((duration): duration is number => duration !== null && duration >= 0);
    const totalFinished = completed + failed;
    const failureRate = totalFinished === 0 ? 0 : (failed / totalFinished) * 100;
    const isDeadLetterQueue = queue.name.endsWith('-dlq');
    const classification = classifyQueueHealth({
      backlog,
      oldestPendingAgeSeconds,
      workerConnected,
      failed,
      completed,
      stalled,
      retryLoops,
      paused: (counts['paused'] ?? 0) > 0,
      isDeadLetterQueue,
    });
    const dependencies = this.dependencies(queue.name);

    return componentResult({
      id: `queue-${queue.name}`,
      name: queue.name,
      category: 'queue',
      status: classification.status,
      startedAt,
      message:
        classification.status === 'healthy'
          ? 'Queue connectivity, workload age, failure rate, and required worker state are healthy.'
          : 'Queue worker availability, backlog, age, stalls, retries, or failure rate requires attention.',
      metadata: {
        connected: true,
        workerConnected,
        workerSignal: workers === null ? 'unknown' : 'bullmq_client_list',
        workerCount: workers?.length ?? null,
        concurrency,
        paused: (counts['paused'] ?? 0) > 0,
        active,
        waiting,
        delayed,
        completed,
        failed,
        retried: retryLoops,
        stalled,
        backlog,
        oldestPendingAt: oldestPending === null ? null : new Date(oldestPending).toISOString(),
        oldestPendingAgeSeconds:
          oldestPendingAgeSeconds === null ? null : Math.round(oldestPendingAgeSeconds),
        oldestActiveAt: oldestActive === null ? null : new Date(oldestActive).toISOString(),
        oldestActiveAgeSeconds:
          oldestActiveAgeSeconds === null ? null : Math.round(oldestActiveAgeSeconds),
        failureRatePercent: Math.round(failureRate * 100) / 100,
        processingRatePerMinute: completedRecently.length / 5,
        averageProcessingDurationMs:
          durations.length === 0
            ? null
            : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
        backlogWarningThreshold: QUEUE_HEALTH_THRESHOLDS.backlogWarning,
        backlogDegradedThreshold: QUEUE_HEALTH_THRESHOLDS.backlogDegraded,
        oldestWarningThresholdSeconds: QUEUE_HEALTH_THRESHOLDS.oldestWarningSeconds,
        oldestDegradedThresholdSeconds: QUEUE_HEALTH_THRESHOLDS.oldestDegradedSeconds,
        failureRateWarningThresholdPercent: QUEUE_HEALTH_THRESHOLDS.failureRateWarningPercent,
        failureRateDegradedThresholdPercent: QUEUE_HEALTH_THRESHOLDS.failureRateDegradedPercent,
      },
      warnings: [
        ...(workerConnected === null
          ? ['BullMQ worker discovery is unsupported by this Redis host; worker state is unknown.']
          : []),
        ...(workerConnected === false && backlog === 0 && !isDeadLetterQueue
          ? ['No worker is connected, but the queue has no open work.']
          : []),
      ],
      errorCode: classification.reasonCode,
      recommendation:
        classification.status === 'healthy'
          ? null
          : 'Inspect worker deployment, failed reasons, retry attempts, stalled jobs, and processing throughput without deleting job history.',
      dependencies: Object.keys(dependencies),
      dependencyTypes: dependencies,
      importance: isDeadLetterQueue ? 'optional' : 'important',
      required: !isDeadLetterQueue,
    });
  }

  private oldest(jobs: Job[], timestamp: (job: Job) => number): number | null {
    if (jobs.length === 0) return null;
    const timestamps = jobs.map(timestamp).filter((value) => Number.isFinite(value) && value > 0);
    return timestamps.length === 0 ? null : Math.min(...timestamps);
  }

  private dependencies(name: string): Partial<Record<string, HealthDependencyType>> {
    const worker = `worker-${name}`;
    const dependencies: Partial<Record<string, HealthDependencyType>> = {
      redis: 'direct',
      [worker]: 'operational',
    };
    if (name === QUEUE_NAMES.PARENT_NOTIFICATIONS) {
      dependencies['postgresql'] = 'operational';
      dependencies['meta-whatsapp'] = 'optional';
      dependencies['twilio-sms'] = 'optional';
    } else if (name === QUEUE_NAMES.EMAIL) {
      dependencies['mailersend-email'] = 'operational';
    } else if (name === QUEUE_NAMES.GAMIFICATION) {
      dependencies['postgresql'] = 'operational';
    }
    return dependencies;
  }
}
