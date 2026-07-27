import { HealthRiskService } from './health-risk.service';
import type { HealthMetricsService } from './health-metrics.service';
import type { HealthComponentResult, HealthMetricPoint } from './health.types';

describe('HealthRiskService', () => {
  it('only emits explainable risks after enough rising history exists', async () => {
    const samples: HealthMetricPoint[] = Array.from({ length: 8 }, (_, index) => ({
      timestamp: new Date(Date.now() - (8 - index) * 60_000).toISOString(),
      componentId: 'redis',
      status: 'healthy',
      latencyMs: 10,
      metrics: { memoryUsagePercent: 60 + index * 4 },
    }));
    const metrics = {
      history: jest.fn().mockResolvedValue(samples),
    } as unknown as HealthMetricsService;
    const service = new HealthRiskService(metrics);
    const redis = {
      id: 'redis',
      name: 'Redis',
      category: 'cache',
      status: 'healthy',
      latencyMs: 10,
      checkedAt: new Date().toISOString(),
      lastSuccessAt: null,
      failureCount: 0,
      availabilityPercent: 100,
      message: 'ok',
      metadata: {},
      warnings: [],
      errorCode: null,
      dependencies: [],
      recommendation: null,
    } satisfies HealthComponentResult;
    const result = await service.evaluate([redis]);
    expect(result.historyAvailable).toBe(true);
    expect(result.risks[0]).toMatchObject({
      componentId: 'redis',
      threshold: 80,
      trend: 'rising',
      timeWindow: 'last 6 hours',
    });
  });

  it('reports that more history is required when fewer than six samples exist', async () => {
    const metrics = {
      history: jest.fn().mockResolvedValue([]),
    } as unknown as HealthMetricsService;
    const service = new HealthRiskService(metrics);
    const result = await service.evaluate([]);
    expect(result).toEqual({ risks: [], historyAvailable: false });
  });
});
