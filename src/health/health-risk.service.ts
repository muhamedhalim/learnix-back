import { Injectable } from '@nestjs/common';

import { HealthMetricsService } from './health-metrics.service';
import type { HealthComponentResult, HealthMetricPoint, HealthRisk } from './health.types';

interface RiskRule {
  id: string;
  componentId: string | RegExp;
  metric: string;
  threshold: number;
  level: HealthRisk['level'];
  title: string;
  impact: string;
  action: string;
}

const RULES: RiskRule[] = [
  {
    id: 'redis-memory',
    componentId: 'redis',
    metric: 'memoryUsagePercent',
    threshold: 80,
    level: 'high',
    title: 'Redis memory pressure is increasing',
    impact: 'Cache eviction, queue instability, or Redis unavailability.',
    action: 'Increase capacity, set an appropriate maxmemory policy, or reduce retained data.',
  },
  {
    id: 'database-connections',
    componentId: 'postgresql',
    metric: 'connectionUsagePercent',
    threshold: 75,
    level: 'high',
    title: 'Database connection capacity is approaching saturation',
    impact: 'Requests may wait for or fail to obtain database connections.',
    action:
      'Inspect pool sizing, connection leaks, long-running queries, and database plan limits.',
  },
  {
    id: 'api-errors',
    componentId: 'backend-api',
    metric: 'errorRatePercent',
    threshold: 3,
    level: 'high',
    title: 'API error rate is rising',
    impact: 'More user requests are likely to fail.',
    action: 'Review grouped errors and recent deployments, then isolate the affected routes.',
  },
  {
    id: 'api-memory',
    componentId: 'backend-api',
    metric: 'heapUsagePercent',
    threshold: 80,
    level: 'high',
    title: 'Server memory usage is trending upward',
    impact: 'Garbage collection pressure or an out-of-memory restart.',
    action: 'Compare heap growth with traffic and investigate retained objects.',
  },
  {
    id: 'queue-backlog',
    componentId: /^queue-/u,
    metric: 'backlog',
    threshold: 100,
    level: 'high',
    title: 'Queue backlog is growing',
    impact: 'Background work will complete late or miss operational deadlines.',
    action: 'Restore workers, increase safe concurrency, and inspect repeated job failures.',
  },
  {
    id: 'provider-latency',
    componentId: /^(payment-gateway|meta-whatsapp|twilio-sms|bunny-stream|mailersend-email)$/u,
    metric: '__latency',
    threshold: 1_000,
    level: 'medium',
    title: 'External provider latency is trending upward',
    impact: 'Provider-backed actions may time out or feel unavailable.',
    action: 'Check provider status, rate limits, regional routing, and timeout budgets.',
  },
];

@Injectable()
export class HealthRiskService {
  constructor(private readonly metrics: HealthMetricsService) {}

  public async evaluate(
    components: HealthComponentResult[],
  ): Promise<{ risks: HealthRisk[]; historyAvailable: boolean }> {
    const points = await this.metrics.history(
      '6h',
      components.map((component) => component.id),
    );
    const grouped = new Map<string, HealthMetricPoint[]>();
    for (const point of points) {
      const list = grouped.get(point.componentId) ?? [];
      list.push(point);
      grouped.set(point.componentId, list);
    }
    const enoughHistory = [...grouped.values()].some((samples) => samples.length >= 6);
    const risks: HealthRisk[] = [];

    for (const component of components) {
      const samples = grouped.get(component.id) ?? [];
      if (samples.length < 6) continue;
      for (const rule of RULES) {
        const matches =
          typeof rule.componentId === 'string'
            ? rule.componentId === component.id
            : rule.componentId.test(component.id);
        if (!matches) continue;
        const values = samples
          .map((sample) =>
            rule.metric === '__latency' ? sample.latencyMs : sample.metrics[rule.metric],
          )
          .filter((value): value is number => typeof value === 'number');
        if (values.length < 6) continue;
        const half = Math.floor(values.length / 2);
        const previous = average(values.slice(0, half));
        const current = average(values.slice(half));
        const change = current - previous;
        const rising = change > Math.max(rule.threshold * 0.03, 0.5);
        if (!rising || current < rule.threshold * 0.7) continue;
        const confidence = Math.min(
          95,
          55 + Math.min(25, values.length * 2) + Math.min(15, Math.abs(change)),
        );
        risks.push({
          id: `${rule.id}:${component.id}`,
          level: current >= rule.threshold ? rule.level : rule.level === 'high' ? 'medium' : 'low',
          componentId: component.id,
          title: rule.title,
          evidence: `The recent average increased from ${previous.toFixed(1)} to ${current.toFixed(1)}.`,
          currentValue: Math.round(current * 100) / 100,
          threshold: rule.threshold,
          trend: 'rising',
          estimatedImpact: rule.impact,
          recommendedAction: rule.action,
          confidencePercent: Math.round(confidence),
          timeWindow: 'last 6 hours',
        });
      }
    }

    return { risks, historyAvailable: enoughHistory };
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}
