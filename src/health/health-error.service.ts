import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { resolveAppEnvLabel } from '../config/app-env';
import { HealthErrorGroup } from './entities';
import { sanitiseMessage } from './health-sanitizer.util';
import type { HealthComponentResult } from './health.types';

@Injectable()
export class HealthErrorService {
  constructor(
    @InjectRepository(HealthErrorGroup)
    private readonly errors: Repository<HealthErrorGroup>,
    private readonly config: ConfigService,
  ) {}

  public async recordComponents(components: HealthComponentResult[]): Promise<void> {
    const unhealthy = components.filter((component) =>
      ['degraded', 'down', 'misconfigured'].includes(component.status),
    );
    for (const component of unhealthy) {
      await this.record({
        source: component.id,
        severity: component.status === 'down' ? 'critical' : 'error',
        errorCode: component.errorCode,
        message: component.message,
      });
    }
  }

  public async record(input: {
    source: string;
    severity: string;
    message: string;
    errorCode?: string | null;
    route?: string | null;
    correlationId?: string | null;
  }): Promise<void> {
    // APP_ENV, not NODE_ENV: a staging error and a production error with an
    // identical message must not collapse into the same error group, and the
    // stored label must say which deployment actually produced it. Staging
    // deliberately runs NODE_ENV=production. See docs/NODE_ENV_AUDIT.md #15.
    const environment = resolveAppEnvLabel(this.config.get.bind(this.config));
    const message = sanitiseMessage(input.message);
    const fingerprint = createHash('sha256')
      .update(`${environment}|${input.source}|${input.errorCode ?? ''}|${message}`)
      .digest('hex')
      .slice(0, 40);
    await this.errors.query(
      `INSERT INTO health_error_groups (
        id, fingerprint, severity, source, environment, route, error_code,
        message, occurrence_count, affected_users, correlation_id,
        first_seen, last_seen, resolved_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 1, NULL, $8,
        now(), now(), NULL, now(), now()
      )
      ON CONFLICT (fingerprint, environment)
      DO UPDATE SET
        occurrence_count = health_error_groups.occurrence_count + 1,
        last_seen = now(),
        severity = EXCLUDED.severity,
        correlation_id = EXCLUDED.correlation_id,
        resolved_at = NULL,
        updated_at = now()`,
      [
        fingerprint,
        input.severity,
        input.source,
        environment,
        input.route ?? null,
        input.errorCode ?? null,
        message,
        input.correlationId ?? null,
      ],
    );
  }

  public async list(input: {
    severity?: string;
    component?: string;
    environment?: string;
    route?: string;
    from?: string;
    to?: string;
    status?: 'open' | 'resolved';
    page?: number;
    limit?: number;
  }): Promise<{ data: HealthErrorGroup[]; meta: { page: number; limit: number; total: number } }> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const query = this.errors.createQueryBuilder('error');
    if (input.severity) {
      query.andWhere('error.severity = :severity', { severity: input.severity });
    }
    if (input.component) {
      query.andWhere('error.source = :component', { component: input.component });
    }
    if (input.environment) {
      query.andWhere('error.environment = :environment', {
        environment: input.environment,
      });
    }
    if (input.route) {
      query.andWhere('error.route ILIKE :route', {
        route: `%${input.route.slice(0, 80)}%`,
      });
    }
    if (input.from) {
      const from = new Date(input.from);
      if (!Number.isNaN(from.getTime())) {
        query.andWhere('error.last_seen >= :from', { from });
      }
    } else {
      query.andWhere("error.last_seen >= now() - interval '24 hours'");
    }
    if (input.to) {
      const to = new Date(input.to);
      if (!Number.isNaN(to.getTime())) {
        query.andWhere('error.last_seen <= :to', { to });
      }
    }
    if (input.status === 'resolved') {
      query.andWhere('error.resolved_at IS NOT NULL');
    } else if (input.status === 'open') {
      query.andWhere('error.resolved_at IS NULL');
    }
    const [data, total] = await query
      .orderBy('error.last_seen', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, meta: { page, limit, total } };
  }
}
