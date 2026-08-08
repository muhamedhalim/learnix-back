import { monitorEventLoopDelay } from 'node:perf_hooks';

import { processEnvReader } from '../common/utils/redis-connection.util';
import { resolveAppEnvLabel } from '../config/app-env';
import { resolveCommitSha, resolveRelease, resolveServiceVersion } from './release';

/**
 * Process-lifetime build identity, resolved once. Exposed as a
 * `backend_build_info` gauge (see `renderBuildInfo`) so metric series can be
 * joined to the deployment that produced them.
 */
const buildIdentity = {
  version: resolveServiceVersion(processEnvReader()),
  release: resolveRelease(processEnvReader()) ?? 'unknown',
  commit: resolveCommitSha(processEnvReader()) ?? 'unknown',
  environment: resolveAppEnvLabel(processEnvReader()),
} as const;

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
const QUERY_COUNT_BUCKETS = [0, 1, 2, 3, 4, 5, 10, 20, 50] as const;

/**
 * Width of the rolling window used for the in-process alert-facing values.
 *
 * The cumulative counters below are correct for Prometheus — `rate()` and
 * `increase()` are defined over monotonic counters — but they are WRONG as
 * direct alert inputs: a lifetime error rate latches permanently once it
 * crosses a threshold (re-firing every cooldown long after recovery), and a
 * short spike is diluted to nothing by hours of healthy traffic. The in-house
 * `HealthAlertService` reads a snapshot, not a time series, so it needs
 * genuinely windowed values. Both views are maintained side by side.
 */
const WINDOW_MINUTES = 15;
const MINUTE_MS = 60_000;

/**
 * Domains whose failures are tracked as dedicated counters. These map to the
 * business events the on-call team alerts on (payment/webhook/email/queue
 * failures, unhandled exceptions/rejections).
 */
export type FailureDomain =
  | 'payment'
  | 'webhook'
  | 'email'
  | 'queue'
  | 'unhandled_exception'
  | 'unhandled_rejection';

export const FAILURE_DOMAINS: readonly FailureDomain[] = Object.freeze([
  'payment',
  'webhook',
  'email',
  'queue',
  'unhandled_exception',
  'unhandled_rejection',
]);

/** One minute of the rolling window. Reset in place when its slot is reused. */
interface MinuteBucket {
  minuteIndex: number;
  requests: number;
  serverErrors: number;
  clientErrors: number;
  timeouts: number;
  slowRequests: number;
  durationMsSum: number;
  failures: Map<FailureDomain, number>;
}

function emptyBucket(minuteIndex: number): MinuteBucket {
  return {
    minuteIndex,
    requests: 0,
    serverErrors: 0,
    clientErrors: 0,
    timeouts: 0,
    slowRequests: 0,
    durationMsSum: 0,
    failures: new Map(),
  };
}

// Event-loop delay histogram (nanoseconds). Enabled once at process start; read
// lazily at scrape time. Cheap and dependency-free (Node built-in).
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

interface HttpMetricKey {
  method: string;
  route: string;
  status: number;
}

interface HttpMetricValue {
  requestCount: number;
  durationMsSum: number;
  dbDurationMsSum: number;
  queryCountSum: number;
  responseBytesSum: number;
  durationBuckets: number[];
  queryCountBuckets: number[];
  slowRequestCount: number;
}

export interface HttpPerformanceSample extends HttpMetricKey {
  durationMs: number;
  dbDurationMs: number;
  queryCount: number;
  responseBytes: number;
}

export type CacheMetricOutcome =
  | 'hit'
  | 'miss'
  | 'computation'
  | 'lock_contention'
  | 'fallback_error'
  | 'invalidation';

export interface CacheMetricSample {
  family: string;
  /** Static endpoint name only. IDs and other personal data are forbidden. */
  endpoint: string;
  outcome: CacheMetricOutcome;
  loadTimeMs?: number;
}

/**
 * Rolling-window view over the last `WINDOW_MINUTES`. This is what alert rules
 * and the health dashboard's "current state" read; the lifetime totals in the
 * snapshot remain available for context and for Prometheus.
 */
export interface PerformanceWindowSnapshot {
  windowMinutes: number;
  requests: number;
  serverErrors: number;
  clientErrors: number;
  serverErrorRatePercent: number;
  clientErrorRatePercent: number;
  timeoutRatePercent: number;
  slowRequestRatePercent: number;
  averageLatencyMs: number | null;
  failures: Record<FailureDomain, number>;
}

export interface PerformanceMetricsSnapshot {
  requests: number;
  requestsPerMinute: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  errorRatePercent: number;
  serverErrorRatePercent: number;
  clientErrorRatePercent: number;
  timeoutRatePercent: number;
  slowRequestRatePercent: number;
  responses4xx: number;
  responses5xx: number;
  slowEndpointCount: number;
  successfulQueries: number;
  failedQueries: number;
  averageQueryLatencyMs: number;
  failures: Record<FailureDomain, number>;
  /** Windowed counterpart of the rate/failure fields above. */
  window: PerformanceWindowSnapshot;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  cpuSeconds: number;
  processCpuPercent: number;
  uptimeSeconds: number;
  eventLoopDelayMs: number;
  eventLoopDelayMaxMs: number;
  routeBreakdown: Array<{
    method: string;
    route: string;
    status: number;
    requests: number;
    averageLatencyMs: number;
  }>;
  exceptionBreakdown: Array<{
    method: string;
    route: string;
    status: number;
    exceptionType: string;
    count: number;
  }>;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function metricLabels(key: HttpMetricKey): string {
  return `method="${escapeLabel(key.method)}",route="${escapeLabel(key.route)}",status="${key.status.toString()}"`;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toString();
}

class PerformanceMetricsRegistry {
  private readonly startedAt = Date.now();
  private lastCpuSampleAt = Date.now();
  private lastCpuUsage = process.cpuUsage();
  private readonly httpMetrics = new Map<string, HttpMetricValue>();
  private successfulQueries = 0;
  private failedQueries = 0;
  private queryDurationMsSum = 0;
  private readonly failureCounts = new Map<FailureDomain, number>();
  private readonly cacheMetrics = new Map<string, { count: number; loadTimeMsSum: number }>();
  private readonly httpExceptions = new Map<string, number>();
  /** Fixed-size ring: one slot per minute of the rolling window. */
  private readonly window: MinuteBucket[] = Array.from({ length: WINDOW_MINUTES }, () =>
    emptyBucket(-1),
  );

  /**
   * Increment a business/runtime failure counter (payment, webhook, email,
   * queue, unhandled exception/rejection). Surfaced as
   * `backend_failures_total{domain="…"}` for Prometheus (cumulative) and as
   * `window.failures[domain]` for the in-process alert rules (last
   * `WINDOW_MINUTES`).
   */
  public recordFailure(domain: FailureDomain): void {
    this.failureCounts.set(domain, (this.failureCounts.get(domain) ?? 0) + 1);
    const bucket = this.currentBucket();
    bucket.failures.set(domain, (bucket.failures.get(domain) ?? 0) + 1);
  }

  /** The bucket for the current minute, reset if its ring slot is stale. */
  private currentBucket(now = Date.now()): MinuteBucket {
    const minuteIndex = Math.floor(now / MINUTE_MS);
    const slot = minuteIndex % WINDOW_MINUTES;
    const bucket = this.window[slot]!;
    if (bucket.minuteIndex !== minuteIndex) {
      this.window[slot] = emptyBucket(minuteIndex);
      return this.window[slot]!;
    }
    return bucket;
  }

  /** Buckets still inside the window, newest-first ordering irrelevant. */
  private liveBuckets(now = Date.now()): MinuteBucket[] {
    const oldest = Math.floor(now / MINUTE_MS) - (WINDOW_MINUTES - 1);
    return this.window.filter((bucket) => bucket.minuteIndex >= oldest);
  }

  private windowSnapshot(now = Date.now()): PerformanceWindowSnapshot {
    const buckets = this.liveBuckets(now);
    let requests = 0;
    let serverErrors = 0;
    let clientErrors = 0;
    let timeouts = 0;
    let slowRequests = 0;
    let durationMsSum = 0;
    const failures = {} as Record<FailureDomain, number>;
    for (const domain of FAILURE_DOMAINS) failures[domain] = 0;

    for (const bucket of buckets) {
      requests += bucket.requests;
      serverErrors += bucket.serverErrors;
      clientErrors += bucket.clientErrors;
      timeouts += bucket.timeouts;
      slowRequests += bucket.slowRequests;
      durationMsSum += bucket.durationMsSum;
      for (const [domain, count] of bucket.failures) {
        failures[domain] += count;
      }
    }

    const rate = (value: number): number => (requests === 0 ? 0 : (value / requests) * 100);
    return {
      windowMinutes: WINDOW_MINUTES,
      requests,
      serverErrors,
      clientErrors,
      serverErrorRatePercent: rate(serverErrors),
      clientErrorRatePercent: rate(clientErrors),
      timeoutRatePercent: rate(timeouts),
      slowRequestRatePercent: rate(slowRequests),
      averageLatencyMs: requests === 0 ? null : durationMsSum / requests,
      failures,
    };
  }

  public recordHttp(sample: HttpPerformanceSample): void {
    const mapKey = `${sample.method}\u0000${sample.route}\u0000${sample.status.toString()}`;
    let metric = this.httpMetrics.get(mapKey);

    if (!metric) {
      metric = {
        requestCount: 0,
        durationMsSum: 0,
        dbDurationMsSum: 0,
        queryCountSum: 0,
        responseBytesSum: 0,
        durationBuckets: DURATION_BUCKETS_MS.map(() => 0),
        queryCountBuckets: QUERY_COUNT_BUCKETS.map(() => 0),
        slowRequestCount: 0,
      };
      this.httpMetrics.set(mapKey, metric);
    }

    metric.requestCount++;
    metric.durationMsSum += sample.durationMs;
    metric.dbDurationMsSum += sample.dbDurationMs;
    metric.queryCountSum += sample.queryCount;
    metric.responseBytesSum += sample.responseBytes;
    const isSlow = sample.durationMs >= 500;
    if (isSlow) metric.slowRequestCount++;

    // Mirror into the rolling window so alert rules see CURRENT behaviour.
    const bucket = this.currentBucket();
    bucket.requests++;
    bucket.durationMsSum += sample.durationMs;
    if (isSlow) bucket.slowRequests++;
    if (sample.status >= 500) bucket.serverErrors++;
    else if (sample.status >= 400) bucket.clientErrors++;
    if (sample.status === 408 || sample.status === 504) bucket.timeouts++;

    for (let index = 0; index < DURATION_BUCKETS_MS.length; index++) {
      if (sample.durationMs <= DURATION_BUCKETS_MS[index]!) {
        metric.durationBuckets[index]!++;
      }
    }
    for (let index = 0; index < QUERY_COUNT_BUCKETS.length; index++) {
      if (sample.queryCount <= QUERY_COUNT_BUCKETS[index]!) {
        metric.queryCountBuckets[index]!++;
      }
    }
  }

  public recordHttpException(input: {
    method: string;
    route: string;
    status: number;
    exceptionType: string;
  }): void {
    const safeType =
      input.exceptionType.replaceAll(/[^A-Za-z0-9_.-]/gu, '').slice(0, 80) || 'UnknownError';
    const key = `${input.method}\u0000${input.route}\u0000${input.status.toString()}\u0000${safeType}`;
    this.httpExceptions.set(key, (this.httpExceptions.get(key) ?? 0) + 1);
  }

  public recordQuery(durationMs: number, success: boolean): void {
    if (success) {
      this.successfulQueries++;
    } else {
      this.failedQueries++;
    }
    this.queryDurationMsSum += durationMs;
  }

  /** Application cache metrics, deliberately separate from Redis-wide counters. */
  public recordCache(sample: CacheMetricSample): void {
    const key = `${sample.family}\u0000${sample.endpoint}\u0000${sample.outcome}`;
    const current = this.cacheMetrics.get(key) ?? { count: 0, loadTimeMsSum: 0 };
    current.count++;
    current.loadTimeMsSum += sample.loadTimeMs ?? 0;
    this.cacheMetrics.set(key, current);
  }

  /**
   * Sanitised in-process snapshot for the authenticated health dashboard.
   * It intentionally exposes aggregates only: no route parameters, headers,
   * bodies, user identifiers, or raw request samples.
   */
  public snapshot(): PerformanceMetricsSnapshot {
    let requests = 0;
    let durationMs = 0;
    let responses4xx = 0;
    let responses5xx = 0;
    let timeouts = 0;
    let slowRequests = 0;
    const slowRoutes = new Set<string>();
    const aggregateDurationBuckets = DURATION_BUCKETS_MS.map(() => 0);
    const routeBreakdown: PerformanceMetricsSnapshot['routeBreakdown'] = [];

    for (const [key, metric] of this.httpMetrics) {
      const [method = '', route = '', statusValue = '0'] = key.split('\u0000');
      const status = Number(statusValue);
      requests += metric.requestCount;
      durationMs += metric.durationMsSum;
      if (status >= 400 && status < 500) responses4xx += metric.requestCount;
      if (status >= 500) responses5xx += metric.requestCount;
      if (status === 408 || status === 504) timeouts += metric.requestCount;
      slowRequests += metric.slowRequestCount;
      for (let index = 0; index < aggregateDurationBuckets.length; index++) {
        aggregateDurationBuckets[index]! += metric.durationBuckets[index] ?? 0;
      }
      routeBreakdown.push({
        method,
        route,
        status,
        requests: metric.requestCount,
        averageLatencyMs: metric.durationMsSum / Math.max(metric.requestCount, 1),
      });
      if (metric.requestCount > 0 && metric.durationMsSum / metric.requestCount >= 500) {
        slowRoutes.add(route);
      }
    }
    const p95Target = Math.ceil(requests * 0.95);
    const p95BucketIndex =
      requests === 0 ? -1 : aggregateDurationBuckets.findIndex((count) => count >= p95Target);
    const p95LatencyMs =
      p95BucketIndex === -1
        ? requests === 0
          ? null
          : DURATION_BUCKETS_MS.at(-1)!
        : DURATION_BUCKETS_MS[p95BucketIndex]!;
    const exceptionBreakdown: PerformanceMetricsSnapshot['exceptionBreakdown'] = [
      ...this.httpExceptions.entries(),
    ]
      .map(([key, count]) => {
        const [method = '', route = '', status = '0', exceptionType = 'UnknownError'] =
          key.split('\u0000');
        return { method, route, status: Number(status), exceptionType, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const now = Date.now();
    const cpuDelta = process.cpuUsage(this.lastCpuUsage);
    const elapsedCpuMicros = Math.max((now - this.lastCpuSampleAt) * 1_000, 1);
    const processCpuPercent = ((cpuDelta.user + cpuDelta.system) / elapsedCpuMicros) * 100;
    this.lastCpuUsage = cpu;
    this.lastCpuSampleAt = now;
    const elapsedMinutes = Math.max((Date.now() - this.startedAt) / 60_000, 1 / 60);
    const totalQueries = this.successfulQueries + this.failedQueries;
    const failures = {} as Record<FailureDomain, number>;
    for (const domain of FAILURE_DOMAINS) {
      failures[domain] = this.failureCounts.get(domain) ?? 0;
    }

    return {
      window: this.windowSnapshot(),
      requests,
      requestsPerMinute: requests / elapsedMinutes,
      averageLatencyMs: requests === 0 ? null : durationMs / requests,
      p95LatencyMs,
      // Backward-compatible alias: operational error rate is server errors,
      // never expected authentication/not-found client responses.
      errorRatePercent: requests === 0 ? 0 : (responses5xx / requests) * 100,
      serverErrorRatePercent: requests === 0 ? 0 : (responses5xx / requests) * 100,
      clientErrorRatePercent: requests === 0 ? 0 : (responses4xx / requests) * 100,
      timeoutRatePercent: requests === 0 ? 0 : (timeouts / requests) * 100,
      slowRequestRatePercent: requests === 0 ? 0 : (slowRequests / requests) * 100,
      responses4xx,
      responses5xx,
      slowEndpointCount: slowRoutes.size,
      successfulQueries: this.successfulQueries,
      failedQueries: this.failedQueries,
      averageQueryLatencyMs: totalQueries === 0 ? 0 : this.queryDurationMsSum / totalQueries,
      failures,
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
      cpuSeconds: (cpu.user + cpu.system) / 1_000_000,
      processCpuPercent,
      uptimeSeconds: process.uptime(),
      eventLoopDelayMs: eventLoopDelay.mean / 1e6,
      eventLoopDelayMaxMs: eventLoopDelay.max / 1e6,
      routeBreakdown: routeBreakdown.sort((a, b) => b.requests - a.requests).slice(0, 30),
      exceptionBreakdown,
    };
  }

  public renderPrometheus(): string {
    const lines = [
      '# HELP backend_http_request_duration_seconds HTTP request duration.',
      '# TYPE backend_http_request_duration_seconds histogram',
    ];

    for (const [mapKey, metric] of this.httpMetrics) {
      const [method = '', route = '', status = '0'] = mapKey.split('\u0000');
      const key = { method, route, status: Number(status) };
      const labels = metricLabels(key);

      for (let index = 0; index < DURATION_BUCKETS_MS.length; index++) {
        lines.push(
          `backend_http_request_duration_seconds_bucket{${labels},le="${seconds(DURATION_BUCKETS_MS[index]!)}"} ${metric.durationBuckets[index]!.toString()}`,
        );
      }
      lines.push(
        `backend_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${metric.requestCount.toString()}`,
        `backend_http_request_duration_seconds_sum{${labels}} ${seconds(metric.durationMsSum)}`,
        `backend_http_request_duration_seconds_count{${labels}} ${metric.requestCount.toString()}`,
      );
    }

    lines.push(
      '# HELP backend_http_db_duration_seconds_total Total database time attributed to HTTP requests.',
      '# TYPE backend_http_db_duration_seconds_total counter',
      '# HELP backend_http_db_queries_total SQL queries attributed to HTTP requests.',
      '# TYPE backend_http_db_queries_total counter',
      '# HELP backend_http_db_queries SQL queries executed per HTTP request.',
      '# TYPE backend_http_db_queries histogram',
      '# HELP backend_http_response_bytes_total HTTP response body bytes.',
      '# TYPE backend_http_response_bytes_total counter',
    );

    for (const [mapKey, metric] of this.httpMetrics) {
      const [method = '', route = '', status = '0'] = mapKey.split('\u0000');
      const labels = metricLabels({
        method,
        route,
        status: Number(status),
      });
      lines.push(
        `backend_http_db_duration_seconds_total{${labels}} ${seconds(metric.dbDurationMsSum)}`,
        `backend_http_db_queries_total{${labels}} ${metric.queryCountSum.toString()}`,
        `backend_http_response_bytes_total{${labels}} ${metric.responseBytesSum.toString()}`,
      );
      for (let index = 0; index < QUERY_COUNT_BUCKETS.length; index++) {
        lines.push(
          `backend_http_db_queries_bucket{${labels},le="${QUERY_COUNT_BUCKETS[index]!.toString()}"} ${metric.queryCountBuckets[index]!.toString()}`,
        );
      }
      lines.push(
        `backend_http_db_queries_bucket{${labels},le="+Inf"} ${metric.requestCount.toString()}`,
        `backend_http_db_queries_sum{${labels}} ${metric.queryCountSum.toString()}`,
        `backend_http_db_queries_count{${labels}} ${metric.requestCount.toString()}`,
      );
    }

    lines.push(
      '# HELP backend_typeorm_queries_total TypeORM queries by outcome.',
      '# TYPE backend_typeorm_queries_total counter',
      `backend_typeorm_queries_total{success="true"} ${this.successfulQueries.toString()}`,
      `backend_typeorm_queries_total{success="false"} ${this.failedQueries.toString()}`,
      '# HELP backend_typeorm_query_duration_seconds_total Total TypeORM query execution time.',
      '# TYPE backend_typeorm_query_duration_seconds_total counter',
      `backend_typeorm_query_duration_seconds_total ${seconds(this.queryDurationMsSum)}`,
    );

    this.renderHttpStatusCounters(lines);
    this.renderFailureCounters(lines);
    this.renderApplicationCacheMetrics(lines);
    this.renderRuntimeMetrics(lines);
    this.renderBuildInfo(lines);

    lines.push('');
    return lines.join('\n');
  }

  private renderApplicationCacheMetrics(lines: string[]): void {
    lines.push(
      '# HELP backend_app_cache_events_total Application cache events by family, static endpoint, and outcome.',
      '# TYPE backend_app_cache_events_total counter',
      '# HELP backend_app_cache_load_seconds_total Time spent loading application cache entries.',
      '# TYPE backend_app_cache_load_seconds_total counter',
      '# HELP backend_app_cache_hit_ratio Application cache hit ratio for each family and endpoint.',
      '# TYPE backend_app_cache_hit_ratio gauge',
    );

    const ratios = new Map<string, { hits: number; misses: number }>();
    for (const [key, value] of this.cacheMetrics) {
      const [family = '', endpoint = '', outcome = ''] = key.split('\u0000');
      const labels = `family="${escapeLabel(family)}",endpoint="${escapeLabel(endpoint)}",outcome="${escapeLabel(outcome)}"`;
      lines.push(
        `backend_app_cache_events_total{${labels}} ${value.count.toString()}`,
        `backend_app_cache_load_seconds_total{${labels}} ${seconds(value.loadTimeMsSum)}`,
      );
      if (outcome === 'hit' || outcome === 'miss') {
        const ratioKey = `${family}\u0000${endpoint}`;
        const aggregate = ratios.get(ratioKey) ?? { hits: 0, misses: 0 };
        if (outcome === 'hit') aggregate.hits += value.count;
        else aggregate.misses += value.count;
        ratios.set(ratioKey, aggregate);
      }
    }
    for (const [key, value] of ratios) {
      const [family = '', endpoint = ''] = key.split('\u0000');
      const denominator = value.hits + value.misses;
      const ratio = denominator === 0 ? 0 : value.hits / denominator;
      lines.push(
        `backend_app_cache_hit_ratio{family="${escapeLabel(family)}",endpoint="${escapeLabel(endpoint)}"} ${ratio.toString()}`,
      );
    }
  }

  /**
   * HTTP responses grouped by status class (2xx/3xx/4xx/5xx) plus dedicated
   * counters for 401/404, derived from the recorded HTTP samples. Lets Grafana
   * alert on 5xx errors and 401/404 spikes without extra instrumentation.
   */
  private renderHttpStatusCounters(lines: string[]): void {
    const byClass: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    let unauthorized = 0;
    let notFound = 0;

    for (const [mapKey, metric] of this.httpMetrics) {
      const [, , status = '0'] = mapKey.split('\u0000');
      const code = Number(status);
      const bucket = `${Math.floor(code / 100).toString()}xx`;
      const current = byClass[bucket];
      if (current !== undefined) byClass[bucket] = current + metric.requestCount;
      if (code === 401) unauthorized += metric.requestCount;
      if (code === 404) notFound += metric.requestCount;
    }

    lines.push(
      '# HELP backend_http_responses_total HTTP responses by status class.',
      '# TYPE backend_http_responses_total counter',
      `backend_http_responses_total{class="2xx"} ${byClass['2xx']!.toString()}`,
      `backend_http_responses_total{class="3xx"} ${byClass['3xx']!.toString()}`,
      `backend_http_responses_total{class="4xx"} ${byClass['4xx']!.toString()}`,
      `backend_http_responses_total{class="5xx"} ${byClass['5xx']!.toString()}`,
      '# HELP backend_http_unauthorized_total HTTP 401 responses.',
      '# TYPE backend_http_unauthorized_total counter',
      `backend_http_unauthorized_total ${unauthorized.toString()}`,
      '# HELP backend_http_not_found_total HTTP 404 responses.',
      '# TYPE backend_http_not_found_total counter',
      `backend_http_not_found_total ${notFound.toString()}`,
    );
  }

  /** Business/runtime failure counters (payment/webhook/email/queue/unhandled). */
  private renderFailureCounters(lines: string[]): void {
    lines.push(
      '# HELP backend_failures_total Domain failures by type.',
      '# TYPE backend_failures_total counter',
    );
    for (const domain of FAILURE_DOMAINS) {
      lines.push(
        `backend_failures_total{domain="${domain}"} ${(this.failureCounts.get(domain) ?? 0).toString()}`,
      );
    }
  }

  /**
   * Build identity as a Prometheus `*_build_info` gauge — the standard idiom
   * for joining a metric series to the deployment that produced it
   * (`... * on(instance) group_left(release) backend_build_info`). This is what
   * makes "did errors rise after release X?" answerable from metrics, and it
   * carries no runtime data, so it is safe on a scraped endpoint.
   */
  private renderBuildInfo(lines: string[]): void {
    lines.push(
      '# HELP backend_build_info Build/release identity of this process (always 1).',
      '# TYPE backend_build_info gauge',
      `backend_build_info{version="${escapeLabel(buildIdentity.version)}",release="${escapeLabel(
        buildIdentity.release,
      )}",commit="${escapeLabel(buildIdentity.commit)}",environment="${escapeLabel(
        buildIdentity.environment,
      )}",node="${escapeLabel(process.version)}"} 1`,
    );
  }

  /** Process memory/CPU/uptime and event-loop lag, sampled at scrape time. */
  private renderRuntimeMetrics(lines: string[]): void {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const cpuSeconds = (cpu.user + cpu.system) / 1_000_000;

    lines.push(
      '# HELP backend_process_resident_memory_bytes Resident set size in bytes.',
      '# TYPE backend_process_resident_memory_bytes gauge',
      `backend_process_resident_memory_bytes ${memory.rss.toString()}`,
      '# HELP backend_nodejs_heap_used_bytes V8 heap used in bytes.',
      '# TYPE backend_nodejs_heap_used_bytes gauge',
      `backend_nodejs_heap_used_bytes ${memory.heapUsed.toString()}`,
      '# HELP backend_nodejs_heap_total_bytes V8 heap total in bytes.',
      '# TYPE backend_nodejs_heap_total_bytes gauge',
      `backend_nodejs_heap_total_bytes ${memory.heapTotal.toString()}`,
      '# HELP backend_process_cpu_seconds_total Total user+system CPU time.',
      '# TYPE backend_process_cpu_seconds_total counter',
      `backend_process_cpu_seconds_total ${cpuSeconds.toString()}`,
      '# HELP backend_process_uptime_seconds Process uptime in seconds.',
      '# TYPE backend_process_uptime_seconds gauge',
      `backend_process_uptime_seconds ${process.uptime().toString()}`,
      '# HELP backend_nodejs_eventloop_lag_seconds Event-loop delay (mean).',
      '# TYPE backend_nodejs_eventloop_lag_seconds gauge',
      `backend_nodejs_eventloop_lag_seconds ${(eventLoopDelay.mean / 1e9).toString()}`,
      '# HELP backend_nodejs_eventloop_lag_max_seconds Event-loop delay (max).',
      '# TYPE backend_nodejs_eventloop_lag_max_seconds gauge',
      `backend_nodejs_eventloop_lag_max_seconds ${(eventLoopDelay.max / 1e9).toString()}`,
    );
  }
}

export const performanceMetrics = new PerformanceMetricsRegistry();
