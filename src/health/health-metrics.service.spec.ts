import type { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { HealthMetric } from './entities';
import { HealthMetricsService } from './health-metrics.service';
import type { HealthComponentResult, HealthStatus } from './health.types';

function component(status: HealthStatus, checkedAt: Date): HealthComponentResult {
  return {
    id: 'backend-api',
    name: 'Backend API',
    category: 'application',
    status,
    latencyMs: status === 'unknown' ? null : 10,
    checkedAt: checkedAt.toISOString(),
    lastSuccessAt: null,
    failureCount: 0,
    availabilityPercent: null,
    message: 'test',
    metadata: {},
    warnings: [],
    errorCode: null,
    dependencies: [],
    recommendation: null,
    importance: 'critical',
    required: true,
  };
}

function metric(status: HealthStatus, at: Date): HealthMetric {
  return {
    id: crypto.randomUUID(),
    component_id: 'backend-api',
    category: 'application',
    status,
    latency_ms: 10,
    resolution: 'raw',
    bucket_start: at,
    sample_count: 1,
    metrics: {},
    created_at: at,
  };
}

describe('HealthMetricsService', () => {
  it('runs bounded hourly/daily aggregation and retention statements', async () => {
    const repository = {
      query: jest.fn().mockResolvedValue(undefined),
    } as unknown as Repository<HealthMetric>;
    const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const service = new HealthMetricsService(repository, config);
    await service.aggregateAndRetain();
    const sql = (repository.query as jest.Mock).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
    expect(sql).toContain("'hour'");
    expect(sql).toContain("'day'");
    expect(sql).toContain("interval '48 hours'");
    expect(sql).toContain("interval '366 days'");
  });

  describe('sample-based availability', () => {
    const now = new Date('2026-07-29T00:10:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(now);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function serviceWith(history: HealthMetric[]): HealthMetricsService {
      const repository = {
        find: jest.fn().mockResolvedValue(history),
      } as unknown as Repository<HealthMetric>;
      const config = { get: jest.fn() } as unknown as ConfigService;
      return new HealthMetricsService(repository, config);
    }

    it('calculates complete availability from collected samples', async () => {
      const history = [1, 2, 3, 4].map((minutes) =>
        metric('healthy', new Date(now.getTime() - minutes * 60_000)),
      );
      const [result] = await serviceWith(history).enrich([component('healthy', now)]);
      expect(result).toMatchObject({
        availabilityPercent: 100,
        failureCount: 0,
        monitoringCoverage: {
          collectedSamples: 5,
          expectedSamples: 5,
          coveragePercent: 100,
          state: 'available',
        },
      });
      expect(result?.lastSuccessAt).toBe(now.toISOString());
    });

    it('reports partial coverage and insufficient data without inventing downtime', async () => {
      const [result] = await serviceWith([
        metric('healthy', new Date(now.getTime() - 4 * 60_000)),
      ]).enrich([component('healthy', now)]);
      expect(result?.availabilityPercent).toBeNull();
      expect(result?.monitoringCoverage).toMatchObject({
        collectedSamples: 2,
        expectedSamples: 5,
        missedSamples: 3,
        coveragePercent: 40,
        state: 'insufficient_data',
      });
    });

    it('does not count confirmed missed collection intervals as downtime', async () => {
      const history = [7, 8, 9, 10].map((minutes) =>
        metric('healthy', new Date(now.getTime() - minutes * 60_000)),
      );
      const [result] = await serviceWith(history).enrich([component('healthy', now)]);
      expect(result?.availabilityPercent).toBe(100);
      expect(result?.monitoringCoverage?.missedSamples).toBeGreaterThan(0);
    });

    it('excludes disabled samples and labels the capability disabled', async () => {
      const [result] = await serviceWith([]).enrich([component('disabled', now)]);
      expect(result?.availabilityPercent).toBeNull();
      expect(result?.monitoringCoverage?.state).toBe('disabled');
      expect(result?.monitoringCoverage?.eligibleSamples).toBe(0);
    });

    it('resets consecutive failures and updates last success after recovery', async () => {
      const history = [1, 2].map((minutes) =>
        metric('down', new Date(now.getTime() - minutes * 60_000)),
      );
      const [result] = await serviceWith(history).enrich([component('healthy', now)]);
      expect(result?.failureCount).toBe(0);
      expect(result?.lastSuccessAt).toBe(now.toISOString());
      expect(result?.lastFailureAt).toBe(new Date(now.getTime() - 60_000).toISOString());
    });

    it('does not show 0% until the minimum sample size exists', async () => {
      const small = await serviceWith([metric('down', new Date(now.getTime() - 60_000))]).enrich([
        component('down', now),
      ]);
      expect(small[0]?.availabilityPercent).toBeNull();

      const enough = await serviceWith(
        [1, 2, 3, 4].map((minutes) => metric('down', new Date(now.getTime() - minutes * 60_000))),
      ).enrich([component('down', now)]);
      expect(enough[0]?.availabilityPercent).toBe(0);
      expect(enough[0]?.monitoringCoverage?.state).toBe('unavailable');
    });
  });

  it('weights component uptime equally when collection cadences differ', async () => {
    const repository = {
      query: jest.fn().mockResolvedValue([
        {
          component_id: 'fast-probe',
          available_24h: '10',
          eligible_24h: '10',
          available_7d: '10',
          eligible_7d: '10',
          available_30d: '10',
          eligible_30d: '10',
        },
        {
          component_id: 'slow-probe',
          available_24h: '0',
          eligible_24h: '5',
          available_7d: '0',
          eligible_7d: '5',
          available_30d: '0',
          eligible_30d: '5',
        },
      ]),
    } as unknown as Repository<HealthMetric>;
    const service = new HealthMetricsService(repository, {
      get: jest.fn(),
    } as unknown as ConfigService);
    await expect(service.uptimeWindows(['fast-probe', 'slow-probe'])).resolves.toEqual({
      last24Hours: 50,
      last7Days: 50,
      last30Days: 50,
    });
  });
});
