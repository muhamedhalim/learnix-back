import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  performanceMetrics,
  type PerformanceMetricsSnapshot,
} from '../../observability/performance-metrics.registry';
import { resolveRelease, resolveServiceVersion } from '../../observability/release';
import type { HealthIndicator } from '../health-indicator.interface';
import type { HealthComponentResult } from '../health.types';
import { componentResult } from './indicator-result.util';

export const API_HEALTH_THRESHOLDS = {
  minimumRequests: 20,
  serverErrorWarningPercent: 1,
  serverErrorDegradedPercent: 5,
  timeoutWarningPercent: 1,
  timeoutDegradedPercent: 3,
  p95LatencyWarningMs: 750,
  p95LatencyDegradedMs: 2_000,
  eventLoopWarningMs: 100,
  eventLoopDegradedMs: 250,
  heapWarningPercent: 80,
  heapDegradedPercent: 92,
} as const;

export function classifyApiHealth(input: {
  requests: number;
  serverErrorRatePercent: number;
  timeoutRatePercent: number;
  p95LatencyMs: number | null;
  eventLoopDelayMs: number;
  heapUsagePercent: number;
}): { status: HealthComponentResult['status']; reasonCode: string | null } {
  const rateSampleReady = input.requests >= API_HEALTH_THRESHOLDS.minimumRequests;
  if (
    (rateSampleReady &&
      input.serverErrorRatePercent >= API_HEALTH_THRESHOLDS.serverErrorDegradedPercent) ||
    (rateSampleReady && input.timeoutRatePercent >= API_HEALTH_THRESHOLDS.timeoutDegradedPercent) ||
    (input.p95LatencyMs !== null &&
      input.p95LatencyMs >= API_HEALTH_THRESHOLDS.p95LatencyDegradedMs) ||
    input.eventLoopDelayMs >= API_HEALTH_THRESHOLDS.eventLoopDegradedMs ||
    input.heapUsagePercent >= API_HEALTH_THRESHOLDS.heapDegradedPercent
  ) {
    const reasonCode =
      rateSampleReady &&
      input.serverErrorRatePercent >= API_HEALTH_THRESHOLDS.serverErrorDegradedPercent
        ? 'API_5XX_RATE_HIGH'
        : rateSampleReady &&
            input.timeoutRatePercent >= API_HEALTH_THRESHOLDS.timeoutDegradedPercent
          ? 'API_TIMEOUT_RATE_HIGH'
          : input.eventLoopDelayMs >= API_HEALTH_THRESHOLDS.eventLoopDegradedMs
            ? 'API_EVENT_LOOP_LAG_HIGH'
            : input.heapUsagePercent >= API_HEALTH_THRESHOLDS.heapDegradedPercent
              ? 'API_MEMORY_PRESSURE_HIGH'
              : 'API_P95_LATENCY_HIGH';
    return { status: 'degraded', reasonCode };
  }
  if (
    (rateSampleReady &&
      input.serverErrorRatePercent >= API_HEALTH_THRESHOLDS.serverErrorWarningPercent) ||
    (rateSampleReady && input.timeoutRatePercent >= API_HEALTH_THRESHOLDS.timeoutWarningPercent) ||
    (input.p95LatencyMs !== null &&
      input.p95LatencyMs >= API_HEALTH_THRESHOLDS.p95LatencyWarningMs) ||
    input.eventLoopDelayMs >= API_HEALTH_THRESHOLDS.eventLoopWarningMs ||
    input.heapUsagePercent >= API_HEALTH_THRESHOLDS.heapWarningPercent
  ) {
    return { status: 'warning', reasonCode: 'API_THRESHOLD_WARNING' };
  }
  return { status: 'healthy', reasonCode: null };
}

@Injectable()
export class BackendApiHealthIndicator implements HealthIndicator {
  public readonly id = 'backend-api';

  public constructor(private readonly config: ConfigService) {}

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const snapshot: PerformanceMetricsSnapshot = performanceMetrics.snapshot();
    const { window } = snapshot;
    const heapUsagePercent =
      snapshot.memory.heapTotalBytes === 0
        ? 0
        : (snapshot.memory.heapUsedBytes / snapshot.memory.heapTotalBytes) * 100;
    // Classified on the ROLLING WINDOW, not lifetime totals. A health
    // indicator must answer "is the API healthy now"; a lifetime error rate
    // both latches after recovery and dilutes a live spike into nothing.
    const classification = classifyApiHealth({
      requests: window.requests,
      serverErrorRatePercent: window.serverErrorRatePercent,
      timeoutRatePercent: window.timeoutRatePercent,
      p95LatencyMs: snapshot.p95LatencyMs,
      eventLoopDelayMs: snapshot.eventLoopDelayMs,
      heapUsagePercent,
    });
    const version = resolveServiceVersion(this.config.get.bind(this.config));
    const release = resolveRelease(this.config.get.bind(this.config)) ?? null;

    return {
      ...componentResult({
        id: this.id,
        name: 'Backend API',
        category: 'application',
        status: classification.status,
        startedAt,
        message:
          classification.status === 'healthy'
            ? 'API runtime metrics are within the documented operational thresholds.'
            : 'API 5xx rate, timeouts, p95 latency, event-loop lag, or memory pressure requires investigation.',
        metadata: {
          // ---------------------------------------------------------------
          // Alert-facing values. `HealthAlertService` reads these BY NAME
          // (see DEFAULT_RULES) and a missing key silently disables its rule,
          // so every metric named by a rule must exist here. All are windowed
          // — see the classification comment above.
          // ---------------------------------------------------------------
          averageLatencyMs:
            window.averageLatencyMs === null
              ? null
              : Math.round(window.averageLatencyMs * 100) / 100,
          errorRatePercent: Math.round(window.serverErrorRatePercent * 100) / 100,
          paymentFailures: window.failures.payment,
          webhookFailures: window.failures.webhook,
          emailFailures: window.failures.email,
          queueFailures: window.failures.queue,
          unhandledExceptionFailures:
            window.failures.unhandled_exception + window.failures.unhandled_rejection,
          // ---------------------------------------------------------------
          // Current-window diagnostics.
          // ---------------------------------------------------------------
          windowMinutes: window.windowMinutes,
          windowRequests: window.requests,
          windowServerErrors: window.serverErrors,
          p95LatencyMs: snapshot.p95LatencyMs,
          serverErrorRatePercent: Math.round(window.serverErrorRatePercent * 100) / 100,
          clientErrorRatePercent: Math.round(window.clientErrorRatePercent * 100) / 100,
          timeoutRatePercent: Math.round(window.timeoutRatePercent * 100) / 100,
          slowRequestRatePercent: Math.round(window.slowRequestRatePercent * 100) / 100,
          // ---------------------------------------------------------------
          // Lifetime totals, retained for context (and matching /metrics).
          // ---------------------------------------------------------------
          lifetimeAverageLatencyMs:
            snapshot.averageLatencyMs === null
              ? null
              : Math.round(snapshot.averageLatencyMs * 100) / 100,
          lifetimeServerErrorRatePercent: Math.round(snapshot.serverErrorRatePercent * 100) / 100,
          lifetimePaymentFailures: snapshot.failures.payment,
          lifetimeEmailFailures: snapshot.failures.email,
          lifetimeQueueFailures: snapshot.failures.queue,
          lifetimeWebhookFailures: snapshot.failures.webhook,
          requests: snapshot.requests,
          requestsPerMinute: Math.round(snapshot.requestsPerMinute * 100) / 100,
          slowEndpointCount: snapshot.slowEndpointCount,
          responses4xx: snapshot.responses4xx,
          responses5xx: snapshot.responses5xx,
          routeBreakdown: snapshot.routeBreakdown,
          exceptionBreakdown: snapshot.exceptionBreakdown,
          processUptimeSeconds: Math.round(snapshot.uptimeSeconds),
          rssBytes: snapshot.memory.rssBytes,
          heapUsedBytes: snapshot.memory.heapUsedBytes,
          heapTotalBytes: snapshot.memory.heapTotalBytes,
          heapUsagePercent: Math.round(heapUsagePercent * 100) / 100,
          processCpuPercent: Math.round(snapshot.processCpuPercent * 100) / 100,
          eventLoopDelayMs: Math.round(snapshot.eventLoopDelayMs * 100) / 100,
          eventLoopDelayMaxMs: Math.round(snapshot.eventLoopDelayMaxMs * 100) / 100,
          minimumRequestThreshold: API_HEALTH_THRESHOLDS.minimumRequests,
          serverErrorWarningThresholdPercent: API_HEALTH_THRESHOLDS.serverErrorWarningPercent,
          serverErrorDegradedThresholdPercent: API_HEALTH_THRESHOLDS.serverErrorDegradedPercent,
          timeoutWarningThresholdPercent: API_HEALTH_THRESHOLDS.timeoutWarningPercent,
          timeoutDegradedThresholdPercent: API_HEALTH_THRESHOLDS.timeoutDegradedPercent,
          p95LatencyWarningThresholdMs: API_HEALTH_THRESHOLDS.p95LatencyWarningMs,
          p95LatencyDegradedThresholdMs: API_HEALTH_THRESHOLDS.p95LatencyDegradedMs,
          eventLoopWarningThresholdMs: API_HEALTH_THRESHOLDS.eventLoopWarningMs,
          eventLoopDegradedThresholdMs: API_HEALTH_THRESHOLDS.eventLoopDegradedMs,
          heapWarningThresholdPercent: API_HEALTH_THRESHOLDS.heapWarningPercent,
          heapDegradedThresholdPercent: API_HEALTH_THRESHOLDS.heapDegradedPercent,
          failedQueries: snapshot.failedQueries,
          applicationVersion: version,
          release,
        },
        warnings:
          window.requests < API_HEALTH_THRESHOLDS.minimumRequests
            ? [
                `Only ${window.requests.toString()} HTTP requests have been observed in the last ${window.windowMinutes.toString()} minutes; rate-based degradation waits for ${API_HEALTH_THRESHOLDS.minimumRequests.toString()} samples.`,
              ]
            : [],
        errorCode: classification.reasonCode,
        recommendation:
          classification.status === 'healthy'
            ? null
            : 'Inspect the aggregated route/status/exception breakdown, 5xx errors, timeouts, memory growth, and event-loop delay.',
        critical: true,
        importance: 'critical',
        required: true,
      }),
      latencyMs: snapshot.requests === 0 ? null : snapshot.p95LatencyMs,
    };
  }
}
