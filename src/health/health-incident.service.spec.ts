import type { Repository } from 'typeorm';

import { HealthIncident, HealthMetric } from './entities';
import { HealthIncidentService } from './health-incident.service';
import type { HealthComponentResult } from './health.types';

describe('HealthIncidentService', () => {
  it('deduplicates repeated degraded checks into one open incident', async () => {
    const open = {
      id: 'incident',
      component_id: 'redis',
      status: 'open',
      occurrence_count: 1,
    } as HealthIncident;
    const incidentRepository = {
      findOne: jest.fn().mockResolvedValue(open),
      save: jest.fn().mockResolvedValue(open),
    } as unknown as Repository<HealthIncident>;
    const metricRepository = {
      find: jest.fn().mockResolvedValue([
        { status: 'degraded', bucket_start: new Date() },
        { status: 'degraded', bucket_start: new Date(Date.now() - 60_000) },
      ]),
    } as unknown as Repository<HealthMetric>;
    const service = new HealthIncidentService(incidentRepository, metricRepository);
    const component = {
      id: 'redis',
      name: 'Redis',
      category: 'cache',
      status: 'degraded',
      latencyMs: 300,
      checkedAt: new Date().toISOString(),
      lastSuccessAt: null,
      failureCount: 2,
      availabilityPercent: 90,
      message: 'slow',
      metadata: {},
      warnings: [],
      errorCode: 'REDIS_SLOW',
      dependencies: [],
      recommendation: null,
      critical: true,
    } satisfies HealthComponentResult;
    await service.evaluate([component]);
    expect(incidentRepository.save).toHaveBeenCalledTimes(1);
    expect(open.occurrence_count).toBe(2);
  });
});
