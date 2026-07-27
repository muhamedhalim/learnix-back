import type { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { HealthMetric } from './entities';
import { HealthMetricsService } from './health-metrics.service';

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
});
