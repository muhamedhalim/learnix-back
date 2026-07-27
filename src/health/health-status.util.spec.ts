import { calculateHealthScore, calculateOverallStatus } from './health-status.util';
import type { HealthComponentResult, HealthStatus } from './health.types';

function component(id: string, status: HealthStatus, critical = false): HealthComponentResult {
  return {
    id,
    name: id,
    category: 'application',
    status,
    latencyMs: 10,
    checkedAt: new Date().toISOString(),
    lastSuccessAt: null,
    failureCount: status === 'healthy' ? 0 : 1,
    availabilityPercent: null,
    message: 'test',
    metadata: {},
    warnings: [],
    errorCode: null,
    dependencies: [],
    recommendation: null,
    critical,
  };
}

describe('health status calculation', () => {
  it('keeps optional warnings operational', () => {
    expect(
      calculateOverallStatus([component('api', 'healthy', true), component('sentry', 'warning')]),
    ).toBe('operational');
  });

  it('returns a partial outage for one critical component down', () => {
    expect(
      calculateOverallStatus([component('api', 'healthy', true), component('db', 'down', true)]),
    ).toBe('partial_outage');
  });

  it('returns a major outage for two critical components down', () => {
    expect(
      calculateOverallStatus([component('db', 'down', true), component('redis', 'down', true)]),
    ).toBe('major_outage');
  });

  it('weights critical components more heavily in the health score', () => {
    const healthy = calculateHealthScore([
      component('api', 'healthy', true),
      component('optional', 'healthy'),
    ]);
    const criticalFailure = calculateHealthScore([
      component('api', 'down', true),
      component('optional', 'healthy'),
    ]);
    expect(healthy).toBe(100);
    expect(criticalFailure).toBeLessThan(30);
  });
});
