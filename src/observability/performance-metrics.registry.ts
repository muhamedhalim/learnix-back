import { monitorEventLoopDelay } from 'node:perf_hooks';

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
const QUERY_COUNT_BUCKETS = [0, 1, 2, 3, 4, 5, 10, 20, 50] as const;

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
}

export interface HttpPerformanceSample extends HttpMetricKey {
  durationMs: number;
  dbDurationMs: number;
  queryCount: number;
  responseBytes: number;
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
  private readonly httpMetrics = new Map<string, HttpMetricValue>();
  private successfulQueries = 0;
  private failedQueries = 0;
  private queryDurationMsSum = 0;
  private readonly failureCounts = new Map<FailureDomain, number>();

  /**
   * Increment a business/runtime failure counter (payment, webhook, email,
   * queue, unhandled exception/rejection). Surfaced as
   * `backend_failures_total{domain="…"}` and alerted on in Grafana.
   */
  public recordFailure(domain: FailureDomain): void {
    this.failureCounts.set(domain, (this.failureCounts.get(domain) ?? 0) + 1);
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
      };
      this.httpMetrics.set(mapKey, metric);
    }

    metric.requestCount++;
    metric.durationMsSum += sample.durationMs;
    metric.dbDurationMsSum += sample.dbDurationMs;
    metric.queryCountSum += sample.queryCount;
    metric.responseBytesSum += sample.responseBytes;

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

  public recordQuery(durationMs: number, success: boolean): void {
    if (success) {
      this.successfulQueries++;
    } else {
      this.failedQueries++;
    }
    this.queryDurationMsSum += durationMs;
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
    this.renderRuntimeMetrics(lines);

    lines.push('');
    return lines.join('\n');
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
    const domains: FailureDomain[] = [
      'payment',
      'webhook',
      'email',
      'queue',
      'unhandled_exception',
      'unhandled_rejection',
    ];
    for (const domain of domains) {
      lines.push(
        `backend_failures_total{domain="${domain}"} ${(this.failureCounts.get(domain) ?? 0).toString()}`,
      );
    }
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
