import type { ConfigService } from '@nestjs/config';

import { performanceMetrics } from '../../observability/performance-metrics.registry';
import { BackendApiHealthIndicator } from './backend-api.indicator';

function buildIndicator(env: Record<string, string> = {}): BackendApiHealthIndicator {
  return new BackendApiHealthIndicator({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

describe('BackendApiHealthIndicator — alert-facing metadata', () => {
  it('publishes every metric key the seeded alert rules name', async () => {
    const result = await buildIndicator().check();

    // These names are read BY STRING from HealthAlertService.DEFAULT_RULES.
    // A missing key silently disables its rule — which is exactly how
    // `repeated-payment-failures` was dead on arrival.
    for (const key of [
      'paymentFailures',
      'emailFailures',
      'queueFailures',
      'errorRatePercent',
      'averageLatencyMs',
    ]) {
      expect(result.metadata).toHaveProperty(key);
    }
  });

  it('surfaces a recorded payment failure through the alert-facing key', async () => {
    const before = (await buildIndicator().check()).metadata['paymentFailures'] as number;

    performanceMetrics.recordFailure('payment');

    const after = (await buildIndicator().check()).metadata['paymentFailures'] as number;
    expect(after).toBe(before + 1);
  });

  it('also surfaces webhook failures for signature/processing spikes', async () => {
    const before = (await buildIndicator().check()).metadata['webhookFailures'] as number;
    performanceMetrics.recordFailure('webhook');
    const after = (await buildIndicator().check()).metadata['webhookFailures'] as number;
    expect(after).toBe(before + 1);
  });

  it('reports the windowed error rate, not the lifetime rate, as errorRatePercent', async () => {
    const result = await buildIndicator().check();
    expect(result.metadata['errorRatePercent']).toBe(result.metadata['serverErrorRatePercent']);
    // The lifetime value is retained separately for context.
    expect(result.metadata).toHaveProperty('lifetimeServerErrorRatePercent');
  });

  it('labels the window so the number is interpretable', async () => {
    const result = await buildIndicator().check();
    expect(result.metadata['windowMinutes']).toBe(15);
  });

  it('attaches the resolved release so a health snapshot names its deployment', async () => {
    const result = await buildIndicator({ SENTRY_RELEASE: 'rel-42' }).check();
    expect(result.metadata['release']).toBe('rel-42');
    expect(result.metadata['applicationVersion']).toBeDefined();
  });

  it('keeps the historical version fallback when nothing is configured', async () => {
    const result = await buildIndicator().check();
    expect(result.metadata['applicationVersion']).toBeDefined();
  });
});
