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
    importance: critical ? 'critical' : 'optional',
    required: critical,
  };
}

describe('health status calculation', () => {
  it('returns operational and 100 for healthy core services', () => {
    const components = [component('api', 'healthy', true), component('db', 'healthy', true)];
    expect(calculateOverallStatus(components)).toBe('operational');
    expect(calculateHealthScore(components)).toBe(100);
  });

  it('reports optional warnings without declaring an outage', () => {
    expect(
      calculateOverallStatus([component('api', 'healthy', true), component('sentry', 'warning')]),
    ).toBe('operational_with_warnings');
  });

  it('returns a major outage for one user-impacting critical component down', () => {
    expect(
      calculateOverallStatus([component('api', 'healthy', true), component('db', 'down', true)]),
    ).toBe('major_outage');
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

  it('excludes disabled and unknown components from the score', () => {
    expect(
      calculateHealthScore([
        component('api', 'healthy', true),
        component('sentry', 'disabled'),
        component('probe-not-run', 'unknown'),
      ]),
    ).toBe(100);
  });

  it('returns a partial outage for a required important job failure', () => {
    const scheduler = component('scheduler', 'down');
    scheduler.importance = 'important';
    scheduler.required = true;
    expect(calculateOverallStatus([component('api', 'healthy', true), scheduler])).toBe(
      'partial_outage',
    );
  });

  it('counts required important misconfiguration as a partial outage', () => {
    const mail = component('mailersend-email', 'misconfigured');
    mail.importance = 'important';
    mail.required = true;
    expect(calculateOverallStatus([component('api', 'healthy', true), mail])).toBe(
      'partial_outage',
    );
  });

  it('returns degraded for increased critical latency without interruption', () => {
    expect(calculateOverallStatus([component('api', 'degraded', true)])).toBe('degraded');
  });
});
