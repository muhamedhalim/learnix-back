const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
const QUERY_COUNT_BUCKETS = [0, 1, 2, 3, 4, 5, 10, 20, 50] as const;

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
      '',
    );

    return lines.join('\n');
  }
}

export const performanceMetrics = new PerformanceMetricsRegistry();
