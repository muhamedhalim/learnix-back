import { performanceMetrics } from './performance-metrics.registry';

function sample(status: number, durationMs = 10) {
  return {
    method: 'GET',
    route: `/api/v1/window-test-${status.toString()}`,
    status,
    durationMs,
    dbDurationMs: 0,
    queryCount: 0,
    responseBytes: 0,
  };
}

describe('rolling-window metrics (latched-counter fix)', () => {
  it('counts failures in the window as well as the lifetime counter', () => {
    const before = performanceMetrics.snapshot();

    performanceMetrics.recordFailure('payment');
    performanceMetrics.recordFailure('payment');

    const after = performanceMetrics.snapshot();
    expect(after.failures.payment).toBe(before.failures.payment + 2);
    expect(after.window.failures.payment).toBe(before.window.failures.payment + 2);
  });

  it('exposes every failure domain in the window, defaulting to zero', () => {
    const { window } = performanceMetrics.snapshot();
    expect(window.failures).toEqual(
      expect.objectContaining({
        payment: expect.any(Number),
        webhook: expect.any(Number),
        email: expect.any(Number),
        queue: expect.any(Number),
        unhandled_exception: expect.any(Number),
        unhandled_rejection: expect.any(Number),
      }),
    );
  });

  it('classifies 5xx and 4xx separately in the window', () => {
    const before = performanceMetrics.snapshot().window;

    performanceMetrics.recordHttp(sample(500));
    performanceMetrics.recordHttp(sample(404));
    performanceMetrics.recordHttp(sample(200));

    const after = performanceMetrics.snapshot().window;
    expect(after.serverErrors).toBe(before.serverErrors + 1);
    expect(after.clientErrors).toBe(before.clientErrors + 1);
    expect(after.requests).toBe(before.requests + 3);
  });

  it('counts gateway timeouts toward the timeout rate', () => {
    const before = performanceMetrics.snapshot().window;
    performanceMetrics.recordHttp(sample(504));
    const after = performanceMetrics.snapshot().window;
    expect(after.timeoutRatePercent).toBeGreaterThan(0);
    expect(after.requests).toBe(before.requests + 1);
  });

  it('reports the window width so a dashboard can label the number', () => {
    expect(performanceMetrics.snapshot().window.windowMinutes).toBe(15);
  });

  it('keeps the cumulative counters monotonic for Prometheus rate()', () => {
    const first = performanceMetrics.snapshot().requests;
    performanceMetrics.recordHttp(sample(200));
    const second = performanceMetrics.snapshot().requests;
    expect(second).toBeGreaterThan(first);
  });
});

describe('build info exposition (release correlation)', () => {
  it('emits a backend_build_info gauge with release and environment labels', () => {
    const output = performanceMetrics.renderPrometheus();
    expect(output).toContain('# TYPE backend_build_info gauge');
    expect(output).toMatch(
      /backend_build_info\{version="[^"]*",release="[^"]*",commit="[^"]*",environment="[^"]*",node="[^"]*"\} 1/,
    );
  });

  it('still exposes every failure domain as a cumulative counter', () => {
    const output = performanceMetrics.renderPrometheus();
    for (const domain of [
      'payment',
      'webhook',
      'email',
      'queue',
      'unhandled_exception',
      'unhandled_rejection',
    ]) {
      expect(output).toContain(`backend_failures_total{domain="${domain}"}`);
    }
  });
});
