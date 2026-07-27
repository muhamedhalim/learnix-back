import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import Redis from 'ioredis';

import { resolveRedisUrl } from '../../common/utils/redis-connection.util';
import { QUEUE_NAMES } from '../../queues/queues.constants';
import type { HealthIndicator } from '../health-indicator.interface';
import { errorCode, sanitiseMessage } from '../health-sanitizer.util';
import { withHealthTimeout } from '../health-timeout.util';
import type { HealthComponentResult } from '../health.types';
import { componentResult } from './indicator-result.util';

const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES);

@Injectable()
export class QueueHealthIndicator implements HealthIndicator {
  public readonly id = 'background-queues';

  constructor(private readonly config: ConfigService) {}

  public async check(): Promise<HealthComponentResult[]> {
    const startedAt = Date.now();
    const redisUrl = resolveRedisUrl((key) => this.config.get<string>(key));
    if (!redisUrl) {
      return [
        componentResult({
          id: this.id,
          name: 'Background queues',
          category: 'queue',
          status:
            this.config.get<string>('NODE_ENV') === 'production' ? 'misconfigured' : 'warning',
          startedAt,
          message: 'BullMQ is disabled because Redis is not configured.',
          metadata: { configured: false, queueCount: ALL_QUEUE_NAMES.length },
          errorCode: 'QUEUES_DISABLED',
          recommendation:
            'Configure Redis and start the required BullMQ workers before enabling background workloads.',
          dependencies: ['redis'],
          critical: true,
        }),
      ];
    }

    const client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 3_000,
      commandTimeout: 5_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });

    try {
      await withHealthTimeout(this.id, client.connect(), 4_000);
      return await withHealthTimeout(
        this.id,
        Promise.all(ALL_QUEUE_NAMES.map(async (name) => await this.checkQueue(client, name))),
        8_000,
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
          metadata: { configured: true, queueCount: ALL_QUEUE_NAMES.length },
          errorCode: errorCode(error, 'QUEUE_UNAVAILABLE'),
          recommendation: 'Restore Redis connectivity and verify BullMQ worker processes.',
          dependencies: ['redis'],
          critical: true,
        }),
      ];
    } finally {
      client.disconnect();
    }
  }

  private async checkQueue(client: Redis, name: string): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const prefix = `bull:${name}`;
    const pipeline = client.pipeline();
    pipeline.llen(`${prefix}:wait`);
    pipeline.llen(`${prefix}:active`);
    pipeline.zcard(`${prefix}:delayed`);
    pipeline.zcard(`${prefix}:completed`);
    pipeline.zcard(`${prefix}:failed`);
    pipeline.zcard(`${prefix}:prioritized`);
    pipeline.exists(`${prefix}:stalled-check`);
    pipeline.hexists(`${prefix}:meta`, 'paused');
    pipeline.lindex(`${prefix}:wait`, -1);
    const response = await pipeline.exec();
    const values = (response ?? []).map((entry) => Number(entry?.[1] ?? 0));
    const [waiting, active, delayed, completed, failed, prioritised, workerLock, pausedValue] =
      values;
    const oldestId = response?.[8]?.[1];
    let oldestPendingAt: string | null = null;
    let oldestPendingAgeSeconds: number | null = null;
    if (typeof oldestId === 'string' && oldestId !== '') {
      const timestamp = Number(await client.hget(`${prefix}:${oldestId}`, 'timestamp'));
      if (Number.isFinite(timestamp) && timestamp > 0) {
        oldestPendingAt = new Date(timestamp).toISOString();
        oldestPendingAgeSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
      }
    }

    const backlog = (waiting ?? 0) + (delayed ?? 0) + (prioritised ?? 0);
    const workerConnected = (workerLock ?? 0) > 0 || (active ?? 0) > 0;
    const paused = (pausedValue ?? 0) > 0;
    const hasHistory = (completed ?? 0) + (failed ?? 0) > 0;
    const failureRate = !hasHistory
      ? 0
      : ((failed ?? 0) / ((completed ?? 0) + (failed ?? 0))) * 100;
    let status: HealthComponentResult['status'] = 'healthy';
    if (backlog >= 1_000 || failureRate >= 20 || (oldestPendingAgeSeconds ?? 0) > 3_600) {
      status = 'degraded';
    } else if (
      backlog >= 100 ||
      failureRate >= 5 ||
      (oldestPendingAgeSeconds ?? 0) > 600 ||
      (backlog > 0 && !workerConnected) ||
      paused
    ) {
      status = 'warning';
    }

    return componentResult({
      id: `queue-${name}`,
      name,
      category: 'queue',
      status,
      startedAt,
      message:
        status === 'healthy'
          ? 'Queue backlog and failure rate are within safe thresholds.'
          : 'Queue backlog, job age, worker state, or failure rate needs attention.',
      metadata: {
        workerConnected,
        paused,
        active: active ?? 0,
        waiting: waiting ?? 0,
        delayed: delayed ?? 0,
        completed: completed ?? 0,
        failed: failed ?? 0,
        retried: null,
        stalled: null,
        backlog,
        oldestPendingAt,
        oldestPendingAgeSeconds:
          oldestPendingAgeSeconds === null ? null : Math.round(oldestPendingAgeSeconds),
        failureRatePercent: Math.round(failureRate * 100) / 100,
        processingRatePerMinute: null,
        averageProcessingDurationMs: null,
      },
      warnings: [
        ...(!workerConnected && backlog > 0
          ? ['No active worker heartbeat was detected while jobs are waiting.']
          : []),
        ...(!hasHistory ? ['Processing-rate history is not available for this queue yet.'] : []),
      ],
      recommendation:
        status === 'healthy'
          ? null
          : 'Check worker deployment, failed jobs, retry loops, and queue throughput.',
      dependencies: ['redis', 'backend-api'],
    });
  }
}
