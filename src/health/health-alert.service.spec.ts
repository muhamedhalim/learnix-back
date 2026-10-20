import type { Repository } from 'typeorm';

import { DEFAULT_HEALTH_ALERT_RULES } from '../database/system-seed';
import { HealthAlertRule } from './entities';
import { HealthAlertService } from './health-alert.service';
import type { HealthComponentResult } from './health.types';
import type { OperationalAlertService } from './operational-alert.service';

function buildComponent(overrides: Partial<HealthComponentResult> = {}): HealthComponentResult {
  return {
    id: 'redis',
    name: 'Redis',
    category: 'cache',
    status: 'warning',
    latencyMs: 10,
    checkedAt: new Date().toISOString(),
    lastSuccessAt: null,
    failureCount: 0,
    availabilityPercent: 100,
    message: 'pressure',
    metadata: { memoryUsagePercent: 95 },
    warnings: [],
    errorCode: null,
    dependencies: [],
    recommendation: null,
    ...overrides,
  } as HealthComponentResult;
}

function buildRule(overrides: Partial<HealthAlertRule> = {}): HealthAlertRule {
  return {
    id: 'rule',
    key: 'redis-memory',
    name: 'Redis memory',
    component_id: 'redis',
    metric: 'memoryUsagePercent',
    operator: 'gte',
    threshold: 80,
    duration_seconds: 0,
    cooldown_seconds: 1800,
    severity: 'critical',
    channels: ['in_app'],
    recipients: [],
    enabled: true,
    last_triggered_at: null,
    ...overrides,
  } as HealthAlertRule;
}

function buildService(rule: HealthAlertRule): {
  service: HealthAlertService;
  alerts: { dispatch: jest.Mock };
  rules: Repository<HealthAlertRule>;
} {
  const rules = {
    findBy: jest.fn().mockResolvedValue([rule]),
    save: jest.fn(),
  } as unknown as Repository<HealthAlertRule>;
  const alerts = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const service = new HealthAlertService(rules, alerts as unknown as OperationalAlertService);
  return { service, alerts, rules };
}

describe('HealthAlertService', () => {
  it('honours cooldowns and prevents an alert storm', async () => {
    const rule = buildRule({ last_triggered_at: new Date() });
    const { service, alerts, rules } = buildService(rule);

    await service.evaluate([buildComponent()]);

    expect(alerts.dispatch).not.toHaveBeenCalled();
    expect(rules.save).not.toHaveBeenCalled();
  });

  it('dispatches once the threshold is exceeded and no cooldown applies', async () => {
    const rule = buildRule();
    const { service, alerts, rules } = buildService(rule);

    await service.evaluate([buildComponent()]);

    expect(alerts.dispatch).toHaveBeenCalledTimes(1);
    expect(rules.save).toHaveBeenCalledTimes(1);
  });

  it('routes a critical rule to the external channels regardless of configured channels', async () => {
    // The seeded default is `channels: ['in_app']` with no recipients — which
    // is exactly why critical incidents previously reached nobody.
    const rule = buildRule({ severity: 'critical', channels: ['in_app'], recipients: [] });
    const { service, alerts } = buildService(rule);

    await service.evaluate([buildComponent()]);

    expect(alerts.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        channels: expect.objectContaining({ email: true, webhook: true, inApp: true }),
      }),
    );
  });

  it.each(['critical', 'warning'] as const)(
    'dispatches every %s health rule as a technical alert, never as an admin business notification',
    async (severity) => {
      const rule = buildRule({
        severity,
        key: 'component-degraded',
        name: 'Component becomes degraded',
        component_id: null,
        metric: 'statusRank',
        threshold: 4,
      });
      const { service, alerts } = buildService(rule);

      await service.evaluate([buildComponent({ status: 'degraded', metadata: {} })]);

      // statusRank-based and metric-based rules share this one choke point.
      expect(alerts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          audience: 'technical',
          key: 'health-rule:component-degraded:redis',
        }),
      );
    },
  );

  it('classifies the seeded "Component becomes degraded" rule as technical', async () => {
    const seeded = DEFAULT_HEALTH_ALERT_RULES.find((rule) => rule.key === 'component-degraded');
    expect(seeded?.name).toBe('Component becomes degraded');
    const rule = buildRule({ ...seeded, component_id: null, duration_seconds: 0 } as never);
    const { service, alerts } = buildService(rule);

    await service.evaluate([
      buildComponent({ id: 'postgresql', status: 'degraded', metadata: {} }),
    ]);

    expect(alerts.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'technical', title: 'Component becomes degraded' }),
    );
  });

  it('leaves a warning rule on its configured channels only', async () => {
    const rule = buildRule({ severity: 'warning', channels: ['in_app'], recipients: [] });
    const { service, alerts } = buildService(rule);

    await service.evaluate([buildComponent()]);

    expect(alerts.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warning',
        channels: expect.objectContaining({ email: false, webhook: false, inApp: true }),
      }),
    );
  });

  it('sends only safe diagnostic values, never component internals', async () => {
    const rule = buildRule();
    const { service, alerts } = buildService(rule);

    await service.evaluate([
      buildComponent({
        metadata: { memoryUsagePercent: 95, connectionString: 'redis://user:pw@host' },
      }),
    ]);

    const payload = JSON.stringify(alerts.dispatch.mock.calls[0]?.[0]);
    expect(payload).not.toContain('redis://');
    expect(payload).not.toContain('pw@host');
  });

  describe('payment failure rule (previously inert)', () => {
    const paymentRule = () =>
      buildRule({
        id: 'payment-rule',
        key: 'repeated-payment-failures',
        name: 'Repeated payment failures',
        component_id: 'backend-api',
        metric: 'paymentFailures',
        threshold: 3,
        severity: 'critical',
      });

    const backendApi = (paymentFailures: number | undefined): HealthComponentResult =>
      buildComponent({
        id: 'backend-api',
        name: 'Backend API',
        category: 'application',
        metadata:
          paymentFailures === undefined
            ? { emailFailures: 0 }
            : { paymentFailures, emailFailures: 0 },
      });

    it('becomes eligible when the metric reaches the configured threshold', async () => {
      const { service, alerts } = buildService(paymentRule());

      await service.evaluate([backendApi(3)]);

      expect(alerts.dispatch).toHaveBeenCalledTimes(1);
      expect(alerts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
          context: expect.objectContaining({ metric: 'paymentFailures', value: 3, threshold: 3 }),
        }),
      );
    });

    it('stays quiet below the threshold', async () => {
      const { service, alerts } = buildService(paymentRule());
      await service.evaluate([backendApi(2)]);
      expect(alerts.dispatch).not.toHaveBeenCalled();
    });

    it('is silently inert when the component does not publish the metric (the original bug)', async () => {
      const { service, alerts } = buildService(paymentRule());

      await service.evaluate([backendApi(undefined)]);

      // This is the regression guard: the rule named `paymentFailures` but the
      // indicator only exposed emailFailures/queueFailures, so metricValue()
      // returned null and the rule could never fire. The indicator now
      // publishes the key — see backend-api.indicator.spec.ts.
      expect(alerts.dispatch).not.toHaveBeenCalled();
    });
  });
});
