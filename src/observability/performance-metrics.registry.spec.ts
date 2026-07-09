import { performanceMetrics } from './performance-metrics.registry';

/**
 * The registry is a process-wide singleton, so these tests assert on the
 * *presence and shape* of the exposed series rather than exact counts (other
 * suites may have recorded samples). Failure counters are asserted to increase.
 */
describe('performanceMetrics registry', () => {
  it('renders a valid Prometheus exposition with the core series', () => {
    const output = performanceMetrics.renderPrometheus();

    expect(output).toContain('backend_http_request_duration_seconds');
    expect(output).toContain('backend_http_responses_total{class="5xx"}');
    expect(output).toContain('backend_http_unauthorized_total');
    expect(output).toContain('backend_http_not_found_total');
    expect(output).toContain('backend_failures_total{domain="payment"}');
    expect(output).toContain('backend_process_resident_memory_bytes');
    expect(output).toContain('backend_nodejs_eventloop_lag_seconds');
    expect(output).toContain('backend_process_uptime_seconds');
  });

  it('records HTTP samples and reflects them in status-class counters', () => {
    performanceMetrics.recordHttp({
      method: 'GET',
      route: '/api/v1/test-metric',
      status: 503,
      durationMs: 12,
      dbDurationMs: 1,
      queryCount: 1,
      responseBytes: 100,
    });

    const output = performanceMetrics.renderPrometheus();
    const match = /backend_http_responses_total\{class="5xx"\} (\d+)/.exec(output);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(1);
  });

  it('increments domain failure counters', () => {
    const before = extractFailure('email');
    performanceMetrics.recordFailure('email');
    const after = extractFailure('email');
    expect(after).toBe(before + 1);
  });
});

function extractFailure(domain: string): number {
  const output = performanceMetrics.renderPrometheus();
  const match = new RegExp(
    `backend_failures_total\\{domain="${domain}"\\} (\\d+)`,
  ).exec(output);
  return match ? Number(match[1]) : 0;
}
