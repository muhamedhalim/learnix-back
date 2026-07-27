import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { In, MoreThanOrEqual, Repository } from 'typeorm';

import { HealthMetric } from './entities';
import type { HealthComponentResult, HealthMetricPoint, HealthStatus } from './health.types';

const STATUS_RANK: Record<HealthStatus, number> = {
  healthy: 0,
  unknown: 1,
  warning: 2,
  misconfigured: 3,
  degraded: 4,
  down: 5,
};

@Injectable()
export class HealthMetricsService {
  constructor(
    @InjectRepository(HealthMetric)
    private readonly metrics: Repository<HealthMetric>,
    private readonly config: ConfigService,
  ) {}

  public async record(components: HealthComponentResult[]): Promise<void> {
    const rows = components.map((component) =>
      this.metrics.create({
        component_id: component.id,
        category: component.category,
        status: component.status,
        latency_ms: component.latencyMs,
        resolution: 'raw',
        bucket_start: new Date(component.checkedAt),
        sample_count: 1,
        metrics: this.numericMetadata(component.metadata),
      }),
    );
    await this.metrics.insert(rows);
  }

  public async enrich(components: HealthComponentResult[]): Promise<HealthComponentResult[]> {
    if (components.length === 0) return components;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const history = await this.metrics.find({
      where: {
        component_id: In(components.map((component) => component.id)),
        resolution: 'hour',
        bucket_start: MoreThanOrEqual(since),
      },
      order: { bucket_start: 'DESC' },
      take: 25_000,
    });
    const grouped = new Map<string, HealthMetric[]>();
    for (const metric of history) {
      const list = grouped.get(metric.component_id) ?? [];
      list.push(metric);
      grouped.set(metric.component_id, list);
    }

    return components.map((component) => {
      const samples = grouped.get(component.id) ?? [];
      const successes = samples.filter((sample) => sample.status === 'healthy');
      const failures = samples.filter((sample) =>
        ['degraded', 'down', 'misconfigured'].includes(sample.status),
      );
      return {
        ...component,
        lastSuccessAt:
          component.status === 'healthy'
            ? component.checkedAt
            : (successes[0]?.bucket_start.toISOString() ?? null),
        failureCount: failures.length + (component.status === 'healthy' ? 0 : 1),
        availabilityPercent:
          samples.length === 0
            ? null
            : Math.round((successes.length / samples.length) * 10_000) / 100,
      };
    });
  }

  public async history(
    range: '1h' | '6h' | '24h' | '7d' | '30d',
    componentIds?: string[],
  ): Promise<HealthMetricPoint[]> {
    const durationMs: Record<typeof range, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const resolution = range === '7d' || range === '30d' ? 'hour' : 'raw';
    const query = this.metrics
      .createQueryBuilder('metric')
      .where('metric.bucket_start >= :since', {
        since: new Date(Date.now() - durationMs[range]),
      })
      .andWhere('metric.resolution = :resolution', { resolution })
      .orderBy('metric.bucket_start', 'ASC')
      .take(2_000);
    if (componentIds && componentIds.length > 0) {
      query.andWhere('metric.component_id IN (:...componentIds)', {
        componentIds,
      });
    }
    let rows = await query.getMany();
    if (rows.length === 0 && resolution === 'hour') {
      const fallback = this.metrics
        .createQueryBuilder('metric')
        .where('metric.bucket_start >= :since', {
          since: new Date(Date.now() - durationMs[range]),
        })
        .andWhere("metric.resolution = 'raw'")
        .orderBy('metric.bucket_start', 'ASC')
        .take(2_000);
      if (componentIds && componentIds.length > 0) {
        fallback.andWhere('metric.component_id IN (:...componentIds)', {
          componentIds,
        });
      }
      rows = await fallback.getMany();
    }
    return rows.map((row) => ({
      timestamp: row.bucket_start.toISOString(),
      componentId: row.component_id,
      status: row.status,
      latencyMs: row.latency_ms,
      metrics: row.metrics,
    }));
  }

  public async aggregateAndRetain(): Promise<void> {
    const rawHours = this.retention('HEALTH_RAW_RETENTION_HOURS', 48, 6, 168);
    const hourlyDays = this.retention('HEALTH_HOURLY_RETENTION_DAYS', 31, 7, 180);
    const dailyDays = this.retention('HEALTH_DAILY_RETENTION_DAYS', 366, 30, 1_825);
    await this.metrics.query(`
      INSERT INTO health_metrics (
        id, component_id, category, status, latency_ms, resolution,
        bucket_start, sample_count, metrics, created_at
      )
      SELECT
        gen_random_uuid(),
        component_id,
        max(category),
        (array_agg(status ORDER BY
          CASE status
            WHEN 'down' THEN 5 WHEN 'degraded' THEN 4
            WHEN 'misconfigured' THEN 3 WHEN 'warning' THEN 2
            WHEN 'unknown' THEN 1 ELSE 0 END DESC))[1],
        round(avg(latency_ms))::integer,
        'hour',
        date_trunc('hour', bucket_start),
        count(*)::integer,
        (array_agg(metrics ORDER BY bucket_start DESC))[1],
        now()
      FROM health_metrics
      WHERE resolution = 'raw'
        AND bucket_start >= now() - interval '8 days'
      GROUP BY component_id, date_trunc('hour', bucket_start)
      ON CONFLICT (component_id, resolution, bucket_start)
      DO UPDATE SET
        status = EXCLUDED.status,
        latency_ms = EXCLUDED.latency_ms,
        sample_count = EXCLUDED.sample_count,
        metrics = EXCLUDED.metrics
    `);
    await this.metrics.query(`
      INSERT INTO health_metrics (
        id, component_id, category, status, latency_ms, resolution,
        bucket_start, sample_count, metrics, created_at
      )
      SELECT
        gen_random_uuid(),
        component_id,
        max(category),
        (array_agg(status ORDER BY
          CASE status
            WHEN 'down' THEN 5 WHEN 'degraded' THEN 4
            WHEN 'misconfigured' THEN 3 WHEN 'warning' THEN 2
            WHEN 'unknown' THEN 1 ELSE 0 END DESC))[1],
        round(avg(latency_ms))::integer,
        'day',
        date_trunc('day', bucket_start),
        sum(sample_count)::integer,
        (array_agg(metrics ORDER BY bucket_start DESC))[1],
        now()
      FROM health_metrics
      WHERE resolution = 'hour'
        AND bucket_start >= now() - interval '91 days'
      GROUP BY component_id, date_trunc('day', bucket_start)
      ON CONFLICT (component_id, resolution, bucket_start)
      DO UPDATE SET
        status = EXCLUDED.status,
        latency_ms = EXCLUDED.latency_ms,
        sample_count = EXCLUDED.sample_count,
        metrics = EXCLUDED.metrics
    `);
    await this.metrics.query(
      `DELETE FROM health_metrics WHERE resolution = 'raw' AND bucket_start < now() - interval '${rawHours.toString()} hours'`,
    );
    await this.metrics.query(
      `DELETE FROM health_metrics WHERE resolution = 'hour' AND bucket_start < now() - interval '${hourlyDays.toString()} days'`,
    );
    await this.metrics.query(
      `DELETE FROM health_metrics WHERE resolution = 'day' AND bucket_start < now() - interval '${dailyDays.toString()} days'`,
    );
  }

  private retention(key: string, fallback: number, minimum: number, maximum: number): number {
    const configured = Number(this.config.get<string>(key));
    if (!Number.isFinite(configured)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(configured)));
  }

  public async uptimeWindows(componentIds: string[]): Promise<{
    last24Hours: number | null;
    last7Days: number | null;
    last30Days: number | null;
  }> {
    if (componentIds.length === 0) {
      return { last24Hours: null, last7Days: null, last30Days: null };
    }
    const rows = (await this.metrics.query(
      `SELECT
        avg(CASE WHEN status IN ('down','misconfigured') THEN 0 ELSE 1 END)
          FILTER (WHERE resolution = 'raw' AND bucket_start >= now() - interval '24 hours') * 100 AS uptime_24h,
        avg(CASE WHEN status IN ('down','misconfigured') THEN 0 ELSE 1 END)
          FILTER (WHERE resolution = 'hour' AND bucket_start >= now() - interval '7 days') * 100 AS uptime_7d,
        avg(CASE WHEN status IN ('down','misconfigured') THEN 0 ELSE 1 END)
          FILTER (WHERE resolution IN ('hour','day') AND bucket_start >= now() - interval '30 days') * 100 AS uptime_30d
      FROM health_metrics
      WHERE component_id = ANY($1)`,
      [componentIds],
    )) as unknown as Array<{
      uptime_24h: string | null;
      uptime_7d: string | null;
      uptime_30d: string | null;
    }>;
    const row = rows[0];
    const normalise = (value: string | null | undefined): number | null =>
      value === null || value === undefined ? null : Math.round(Number(value) * 1000) / 1000;
    return {
      last24Hours: normalise(row?.uptime_24h),
      last7Days: normalise(row?.uptime_7d),
      last30Days: normalise(row?.uptime_30d),
    };
  }

  public worstStatus(statuses: HealthStatus[]): HealthStatus {
    return [...statuses].sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? 'unknown';
  }

  private numericMetadata(metadata: Record<string, unknown>): Record<string, number> {
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        numeric[key] = value;
      }
    }
    return numeric;
  }
}
