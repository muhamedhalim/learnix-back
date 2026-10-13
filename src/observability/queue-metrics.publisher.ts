import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { Queue } from 'bullmq';

import { runsBackgroundWork } from '../config/process-role';
import { standaloneQueueOptions } from '../queues/queue-options.util';
import { QUEUE_NAMES } from '../queues/queues.constants';

/** Published once a minute; the worker's ECS target tracking reads it (backlog / running tasks). */
export const QUEUE_BACKLOG_METRIC = 'QueueBacklog';
export const DEAD_LETTER_METRIC = 'DeadLetterJobs';
const INTERVAL_MS = 60_000;

export interface QueueBacklogSample {
  /** Jobs ready to run now (waiting + prioritized) across every work queue. */
  backlog: number;
  /** Jobs parked on dead-letter queues. */
  deadLetter: number;
}

/** Sums BullMQ counts. Delayed jobs are excluded: they are scheduled, not waiting for capacity. */
export function summariseCounts(perQueue: ReadonlyArray<{ name: string; counts: Record<string, number> }>): QueueBacklogSample {
  let backlog = 0;
  let deadLetter = 0;
  for (const { name, counts } of perQueue) {
    const ready = (counts['waiting'] ?? 0) + (counts['prioritized'] ?? 0);
    if (name.endsWith('-dlq')) deadLetter += ready + (counts['failed'] ?? 0);
    else backlog += ready;
  }
  return { backlog, deadLetter };
}

/**
 * Publishes the BullMQ backlog to CloudWatch (namespace QUEUE_METRICS_NAMESPACE, dimension
 * Environment=QUEUE_METRICS_ENVIRONMENT) from every process that runs queue consumers. Several
 * workers publish the same total; the scaling policy reads the Average, so duplicates are harmless.
 *
 * Off unless QUEUE_METRICS_NAMESPACE is set (local and non-AWS deployments publish nothing). Uses the
 * ECS task role (cloudwatch:PutMetricData restricted to that namespace). A failed publish is logged
 * and retried on the next tick; the queue-backlog alarm treats missing data as breaching.
 */
@Injectable()
export class QueueMetricsPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueMetricsPublisher.name);
  private timer: NodeJS.Timeout | null = null;
  private queues: Queue[] = [];
  private client: CloudWatchClient | null = null;
  private namespace = '';
  private environment = '';

  constructor(private readonly config: ConfigService) {}

  public onModuleInit(): void {
    this.namespace = this.config.get<string>('QUEUE_METRICS_NAMESPACE')?.trim() ?? '';
    if (this.namespace === '' || !runsBackgroundWork()) return;

    const options = standaloneQueueOptions((key) => this.config.get<string>(key));
    if (options === null) {
      this.logger.warn('QUEUE_METRICS_NAMESPACE is set but Redis is not configured; not publishing');
      return;
    }
    this.environment =
      this.config.get<string>('QUEUE_METRICS_ENVIRONMENT')?.trim() ||
      this.config.get<string>('APP_ENV') ||
      'unknown';
    this.queues = Object.values(QUEUE_NAMES).map((name) => new Queue(name, options));
    this.client = new CloudWatchClient({ region: this.config.get<string>('AWS_REGION') || 'eu-central-1' });
    this.timer = setInterval(() => void this.publishOnce(), INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Publishing queue backlog to CloudWatch ${this.namespace} every 60s`);
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(this.queues.map(async (queue) => await queue.close()));
    this.client?.destroy();
  }

  /** One sample. Public for tests; never throws. */
  public async publishOnce(): Promise<QueueBacklogSample | null> {
    if (this.client === null) return null;
    try {
      const perQueue = await Promise.all(
        this.queues.map(async (queue) => ({
          name: queue.name,
          counts: await queue.getJobCounts('waiting', 'prioritized', 'failed'),
        })),
      );
      const sample = summariseCounts(perQueue);
      const dimensions = [{ Name: 'Environment', Value: this.environment }];
      const timestamp = new Date();
      await this.client.send(
        new PutMetricDataCommand({
          Namespace: this.namespace,
          MetricData: [
            { MetricName: QUEUE_BACKLOG_METRIC, Dimensions: dimensions, Timestamp: timestamp, Unit: 'Count', Value: sample.backlog },
            { MetricName: DEAD_LETTER_METRIC, Dimensions: dimensions, Timestamp: timestamp, Unit: 'Count', Value: sample.deadLetter },
          ],
        }),
      );
      return sample;
    } catch (err) {
      this.logger.warn(`Queue metrics not published: ${(err as Error).message}`);
      return null;
    }
  }
}
