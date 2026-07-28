import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { In, MoreThanOrEqual, Repository } from 'typeorm';

import { HealthMetric } from './entities';
import type { HealthComponentResult, HealthMetricPoint, HealthStatus } from './health.types';

const STATUS_RANK: Record<HealthStatus, number> = {
  healthy: 0,
  disabled: 0,
  unknown: 1,
  warning: 2,
  misconfigured: 3,
  degraded: 4,
  down: 5,
};

const MINIMUM_AVAILABILITY_SAMPLES = 5;
const AVAILABLE_STATUSES: HealthStatus[] = ['healthy', 'warning', 'degraded'];
const FAILED_STATUSES: HealthStatus[] = ['down', 'misconfigured'];

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
        metrics: {
          ...this.numericMetadata(component.metadata),
          availabilityEligibleSamples: ['disabled', 'unknown'].includes(component.status) ? 0 : 1,
          availableSamples: AVAILABLE_STATUSES.includes(component.status) ? 1 : 0,
        },
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
        bucket_start: MoreThanOrEqual(since),
      },
      order: { bucket_start: 'DESC' },
      take: 100_000,
    });
    const rawCutoff =
      Date.now() - this.retention('HEALTH_RAW_RETENTION_HOURS', 48, 6, 168) * 3_600_000;
    const grouped = new Map<string, HealthMetric[]>();
    for (const metric of history) {
      if (metric.resolution === 'day') continue;
      if (metric.resolution === 'hour' && metric.bucket_start.getTime() >= rawCutoff) continue;
      const list = grouped.get(metric.component_id) ?? [];
      list.push(metric);
      grouped.set(metric.component_id, list);
    }

    return components.map((component) => {
      const samples = grouped.get(component.id) ?? [];
      const currentAt = new Date(component.checkedAt);
      const statusTimeline = [
        { status: component.status, at: currentAt },
        ...samples.map((sample) => ({ status: sample.status, at: sample.bucket_start })),
      ].sort((a, b) => b.at.getTime() - a.at.getTime());
      const successes = statusTimeline.filter((sample) =>
        AVAILABLE_STATUSES.includes(sample.status),
      );
      const failures = statusTimeline.filter((sample) => FAILED_STATUSES.includes(sample.status));
      let consecutiveFailures = 0;
      for (const sample of statusTimeline) {
        if (FAILED_STATUSES.includes(sample.status)) {
          consecutiveFailures++;
          continue;
        }
        if (AVAILABLE_STATUSES.includes(sample.status)) break;
      }

      let collectedSamples = 1;
      let eligibleSamples = ['disabled', 'unknown'].includes(component.status) ? 0 : 1;
      let availableSamples = AVAILABLE_STATUSES.includes(component.status) ? 1 : 0;
      for (const sample of samples) {
        collectedSamples += sample.sample_count;
        if (sample.resolution === 'raw') {
          if (!['disabled', 'unknown'].includes(sample.status)) eligibleSamples++;
          if (AVAILABLE_STATUSES.includes(sample.status)) availableSamples++;
          continue;
        }
        const eligible = sample.metrics['availabilityEligibleSamples'];
        const available = sample.metrics['availableSamples'];
        // Aggregates written before the availability accounting change are
        // intentionally excluded: their worst-status bucket cannot be safely
        // interpreted as per-sample uptime, but the rows remain preserved.
        if (typeof eligible === 'number' && typeof available === 'number') {
          eligibleSamples += eligible;
          availableSamples += available;
        }
      }

      const oldestAt = samples.at(-1)?.bucket_start ?? currentAt;
      const observedPeriodSeconds = Math.max(0, (currentAt.getTime() - oldestAt.getTime()) / 1000);
      const cadenceSeconds = this.retention('HEALTH_COLLECTION_INTERVAL_SECONDS', 60, 10, 3_600);
      const expectedSamples = Math.max(1, Math.floor(observedPeriodSeconds / cadenceSeconds) + 1);
      const missedSamples = Math.max(0, expectedSamples - collectedSamples);
      const coveragePercent =
        expectedSamples === 0
          ? null
          : Math.min(100, Math.round((collectedSamples / expectedSamples) * 10_000) / 100);
      const availabilityPercent =
        eligibleSamples < MINIMUM_AVAILABILITY_SAMPLES
          ? null
          : Math.round((availableSamples / eligibleSamples) * 10_000) / 100;
      const coverageState =
        component.status === 'disabled'
          ? 'disabled'
          : eligibleSamples === 0
            ? 'no_data'
            : eligibleSamples < MINIMUM_AVAILABILITY_SAMPLES
              ? 'insufficient_data'
              : availableSamples === 0
                ? 'unavailable'
                : 'available';
      const monitoringCoverage = {
        state: coverageState,
        observedPeriodSeconds: Math.round(observedPeriodSeconds),
        expectedSamples,
        collectedSamples,
        eligibleSamples,
        missedSamples,
        coveragePercent,
        minimumSamples: MINIMUM_AVAILABILITY_SAMPLES,
      } as const;
      const lastSuccessAt = successes[0]?.at.toISOString() ?? null;
      const lastFailureAt = failures[0]?.at.toISOString() ?? null;
      const recentFailureCount = failures.filter(
        (failure) => failure.at.getTime() >= Date.now() - 24 * 60 * 60 * 1000,
      ).length;
      return {
        ...component,
        lastSuccessAt,
        lastFailureAt,
        failureCount: consecutiveFailures,
        availabilityPercent,
        monitoringCoverage,
        diagnostics: {
          summary: component.message,
          measuredValues: component.metadata,
          thresholds: this.thresholdMetadata(component.metadata),
          reasonCode: component.errorCode,
          lastSuccessAt,
          lastFailureAt,
          recentFailureCount,
          monitoringCoverage,
          recommendedAction: component.recommendation,
        },
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
            WHEN 'unknown' THEN 1 WHEN 'disabled' THEN -1 ELSE 0 END DESC))[1],
        round(avg(latency_ms))::integer,
        'hour',
        date_trunc('hour', bucket_start),
        count(*)::integer,
        (array_agg(metrics ORDER BY bucket_start DESC))[1] || jsonb_build_object(
          'availabilityEligibleSamples', sum(CASE WHEN status IN ('disabled','unknown') THEN 0 ELSE 1 END),
          'availableSamples', sum(CASE WHEN status IN ('healthy','warning','degraded') THEN 1 ELSE 0 END)
        ),
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
            WHEN 'unknown' THEN 1 WHEN 'disabled' THEN -1 ELSE 0 END DESC))[1],
        round(avg(latency_ms))::integer,
        'day',
        date_trunc('day', bucket_start),
        sum(sample_count)::integer,
        (array_agg(metrics ORDER BY bucket_start DESC))[1] || jsonb_build_object(
          'availabilityEligibleSamples', sum(COALESCE((metrics->>'availabilityEligibleSamples')::integer, 0)),
          'availableSamples', sum(COALESCE((metrics->>'availableSamples')::integer, 0))
        ),
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
        component_id,
        sum((metrics->>'availableSamples')::numeric)
          FILTER (WHERE resolution = 'raw' AND bucket_start >= now() - interval '24 hours') AS available_24h,
        sum((metrics->>'availabilityEligibleSamples')::numeric)
          FILTER (WHERE resolution = 'raw' AND bucket_start >= now() - interval '24 hours') AS eligible_24h,
        sum((metrics->>'availableSamples')::numeric)
          FILTER (WHERE resolution = 'hour' AND bucket_start >= now() - interval '7 days') AS available_7d,
        sum((metrics->>'availabilityEligibleSamples')::numeric)
          FILTER (WHERE resolution = 'hour' AND bucket_start >= now() - interval '7 days') AS eligible_7d,
        sum((metrics->>'availableSamples')::numeric)
          FILTER (WHERE resolution = 'hour' AND bucket_start >= now() - interval '30 days') AS available_30d,
        sum((metrics->>'availabilityEligibleSamples')::numeric)
          FILTER (WHERE resolution = 'hour' AND bucket_start >= now() - interval '30 days') AS eligible_30d
      FROM health_metrics
      WHERE component_id = ANY($1)
        AND metrics ? 'availabilityEligibleSamples'
      GROUP BY component_id`,
      [componentIds],
    )) as unknown as Array<{
      component_id: string;
      available_24h: string | null;
      eligible_24h: string | null;
      available_7d: string | null;
      eligible_7d: string | null;
      available_30d: string | null;
      eligible_30d: string | null;
    }>;
    const normalise = (
      availableKey: 'available_24h' | 'available_7d' | 'available_30d',
      eligibleKey: 'eligible_24h' | 'eligible_7d' | 'eligible_30d',
    ): number | null => {
      // Calculate each component's ratio independently before averaging.
      // This prevents a faster cadence or an operator-triggered recheck from
      // giving one component disproportionate influence over platform uptime.
      const ratios = rows.flatMap((row) => {
        const denominator = Number(row[eligibleKey] ?? 0);
        return denominator < MINIMUM_AVAILABILITY_SAMPLES
          ? []
          : [Number(row[availableKey] ?? 0) / denominator];
      });
      if (ratios.length === 0) return null;
      return (
        Math.round((ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length) * 100_000) / 1000
      );
    };
    return {
      last24Hours: normalise('available_24h', 'eligible_24h'),
      last7Days: normalise('available_7d', 'eligible_7d'),
      last30Days: normalise('available_30d', 'eligible_30d'),
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

  private thresholdMetadata(metadata: Record<string, unknown>): Record<string, number | string> {
    const thresholds: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!key.toLowerCase().includes('threshold')) continue;
      if (typeof value === 'number' || typeof value === 'string') thresholds[key] = value;
    }
    return thresholds;
  }
}
