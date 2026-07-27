import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { HealthIncident, HealthMetric } from './entities';
import type { HealthComponentResult } from './health.types';

@Injectable()
export class HealthIncidentService {
  constructor(
    @InjectRepository(HealthIncident)
    private readonly incidents: Repository<HealthIncident>,
    @InjectRepository(HealthMetric)
    private readonly metrics: Repository<HealthMetric>,
  ) {}

  public async evaluate(components: HealthComponentResult[]): Promise<void> {
    for (const component of components) {
      const open = await this.incidents.findOne({
        where: { component_id: component.id, status: 'open' },
        order: { started_at: 'DESC' },
      });
      if (
        ['degraded', 'down'].includes(component.status) ||
        (component.status === 'misconfigured' && component.critical === true)
      ) {
        const recent = await this.metrics.find({
          where: { component_id: component.id, resolution: 'raw' },
          order: { bucket_start: 'DESC' },
          take: 2,
        });
        if (recent.length < 2 || recent.some((sample) => sample.status === 'healthy')) {
          continue;
        }
        if (open) {
          open.last_observed_at = new Date(component.checkedAt);
          open.occurrence_count += 1;
          open.impact = component.message;
          await this.incidents.save(open);
        } else {
          await this.incidents.save(
            this.incidents.create({
              fingerprint: `${component.id}:${component.errorCode ?? component.status}`,
              component_id: component.id,
              severity: component.status === 'down' ? 'critical' : 'degraded',
              status: 'open',
              impact: component.message,
              root_cause: null,
              resolution_summary: null,
              started_at: recent.at(-1)?.bucket_start ?? new Date(component.checkedAt),
              ended_at: null,
              last_observed_at: new Date(component.checkedAt),
              occurrence_count: 1,
            }),
          );
        }
      } else if (open && component.status === 'healthy') {
        open.status = 'resolved';
        open.ended_at = new Date(component.checkedAt);
        open.last_observed_at = new Date(component.checkedAt);
        open.resolution_summary = 'Component recovered and passed subsequent health checks.';
        await this.incidents.save(open);
      }
    }
  }

  public async list(
    page = 1,
    limit = 25,
  ): Promise<{ data: HealthIncident[]; meta: { page: number; limit: number; total: number } }> {
    const boundedPage = Math.max(1, page);
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const [data, total] = await this.incidents.findAndCount({
      order: { started_at: 'DESC' },
      skip: (boundedPage - 1) * boundedLimit,
      take: boundedLimit,
    });
    return {
      data,
      meta: { page: boundedPage, limit: boundedLimit, total },
    };
  }
}
