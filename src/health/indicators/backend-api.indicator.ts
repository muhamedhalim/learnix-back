import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { performanceMetrics } from '../../observability/performance-metrics.registry';
import type { HealthIndicator } from '../health-indicator.interface';
import type { HealthComponentResult } from '../health.types';
import { componentResult } from './indicator-result.util';

@Injectable()
export class BackendApiHealthIndicator implements HealthIndicator {
  public readonly id = 'backend-api';

  constructor(private readonly config: ConfigService) {}

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const snapshot = performanceMetrics.snapshot();
    const heapUsagePercent =
      snapshot.memory.heapTotalBytes === 0
        ? 0
        : (snapshot.memory.heapUsedBytes / snapshot.memory.heapTotalBytes) * 100;
    const status =
      snapshot.errorRatePercent >= 10 || snapshot.eventLoopDelayMs >= 250 || heapUsagePercent >= 92
        ? 'degraded'
        : snapshot.errorRatePercent >= 3 ||
            snapshot.eventLoopDelayMs >= 100 ||
            heapUsagePercent >= 80
          ? 'warning'
          : 'healthy';

    const version =
      this.config.get<string>('APP_VERSION') ??
      this.config.get<string>('npm_package_version') ??
      '0.0.1';

    return componentResult({
      id: this.id,
      name: 'Backend API',
      category: 'application',
      status,
      startedAt,
      message:
        status === 'healthy'
          ? 'API process and runtime indicators are within safe thresholds.'
          : 'API runtime pressure or error rate requires investigation.',
      metadata: {
        averageLatencyMs: Math.round(snapshot.averageLatencyMs * 100) / 100,
        errorRatePercent: Math.round(snapshot.errorRatePercent * 100) / 100,
        requestsPerMinute: Math.round(snapshot.requestsPerMinute * 100) / 100,
        slowEndpointCount: snapshot.slowEndpointCount,
        responses4xx: snapshot.responses4xx,
        responses5xx: snapshot.responses5xx,
        processUptimeSeconds: Math.round(snapshot.uptimeSeconds),
        rssBytes: snapshot.memory.rssBytes,
        heapUsedBytes: snapshot.memory.heapUsedBytes,
        heapTotalBytes: snapshot.memory.heapTotalBytes,
        heapUsagePercent: Math.round(heapUsagePercent * 100) / 100,
        cpuSeconds: Math.round(snapshot.cpuSeconds * 100) / 100,
        processCpuPercent: Math.round(snapshot.processCpuPercent * 100) / 100,
        eventLoopDelayMs: Math.round(snapshot.eventLoopDelayMs * 100) / 100,
        eventLoopDelayMaxMs: Math.round(snapshot.eventLoopDelayMaxMs * 100) / 100,
        failedQueries: snapshot.failedQueries,
        paymentFailures: snapshot.failures.payment,
        webhookFailures: snapshot.failures.webhook,
        emailFailures: snapshot.failures.email,
        queueFailures: snapshot.failures.queue,
        applicationVersion: version,
      },
      warnings:
        snapshot.requests === 0
          ? ['No HTTP traffic has been observed since this process started.']
          : [],
      recommendation:
        status === 'healthy'
          ? null
          : 'Inspect recent 5xx errors, slow routes, memory growth, and event-loop delay.',
      critical: true,
    });
  }
}
