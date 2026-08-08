import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { HealthAlertRule } from './entities';
import type { HealthComponentResult } from './health.types';
import { OperationalAlertService } from './operational-alert.service';

const DEFAULT_RULES: Array<
  Pick<
    HealthAlertRule,
    | 'key'
    | 'name'
    | 'component_id'
    | 'metric'
    | 'operator'
    | 'threshold'
    | 'duration_seconds'
    | 'cooldown_seconds'
    | 'severity'
  >
> = [
  {
    key: 'component-down',
    name: 'Component goes down',
    component_id: null,
    metric: 'statusRank',
    operator: 'gte',
    threshold: 5,
    duration_seconds: 120,
    cooldown_seconds: 1800,
    severity: 'critical',
  },
  {
    key: 'component-degraded',
    name: 'Component becomes degraded',
    component_id: null,
    metric: 'statusRank',
    operator: 'gte',
    threshold: 4,
    duration_seconds: 300,
    cooldown_seconds: 1800,
    severity: 'warning',
  },
  {
    key: 'api-latency',
    name: 'API latency exceeds threshold',
    component_id: 'backend-api',
    metric: 'averageLatencyMs',
    operator: 'gte',
    threshold: 750,
    duration_seconds: 300,
    cooldown_seconds: 1800,
    severity: 'warning',
  },
  {
    key: 'api-error-rate',
    name: 'API error rate exceeds threshold',
    component_id: 'backend-api',
    metric: 'errorRatePercent',
    operator: 'gte',
    threshold: 5,
    duration_seconds: 300,
    cooldown_seconds: 1800,
    severity: 'critical',
  },
  {
    key: 'queue-backlog',
    name: 'Queue backlog exceeds threshold',
    component_id: 'queue-*',
    metric: 'backlog',
    operator: 'gte',
    threshold: 250,
    duration_seconds: 600,
    cooldown_seconds: 1800,
    severity: 'warning',
  },
  {
    key: 'redis-memory',
    name: 'Redis memory exceeds threshold',
    component_id: 'redis',
    metric: 'memoryUsagePercent',
    operator: 'gte',
    threshold: 85,
    duration_seconds: 300,
    cooldown_seconds: 1800,
    severity: 'critical',
  },
  {
    key: 'database-connections',
    name: 'Database connection usage exceeds threshold',
    component_id: 'postgresql',
    metric: 'connectionUsagePercent',
    operator: 'gte',
    threshold: 85,
    duration_seconds: 300,
    cooldown_seconds: 1800,
    severity: 'critical',
  },
  {
    key: 'scheduled-job-missed',
    name: 'Scheduled health job is missed',
    component_id: 'scheduled-jobs',
    metric: 'missedHealthCollections',
    operator: 'gte',
    threshold: 2,
    duration_seconds: 120,
    cooldown_seconds: 1800,
    severity: 'critical',
  },
  {
    key: 'repeated-payment-failures',
    name: 'Repeated payment failures',
    component_id: 'backend-api',
    metric: 'paymentFailures',
    operator: 'gte',
    threshold: 3,
    duration_seconds: 300,
    cooldown_seconds: 1800,
    severity: 'critical',
  },
  {
    key: 'repeated-email-failures',
    name: 'Repeated email failures',
    component_id: 'backend-api',
    metric: 'emailFailures',
    operator: 'gte',
    threshold: 3,
    duration_seconds: 300,
    cooldown_seconds: 1800,
    severity: 'warning',
  },
];

@Injectable()
export class HealthAlertService implements OnModuleInit {
  private readonly firstExceededAt = new Map<string, number>();
  constructor(
    @InjectRepository(HealthAlertRule)
    private readonly rules: Repository<HealthAlertRule>,
    private readonly alerts: OperationalAlertService,
  ) {}

  public async onModuleInit(): Promise<void> {
    for (const rule of DEFAULT_RULES) {
      const existing = await this.rules.findOneBy({ key: rule.key });
      if (!existing) {
        await this.rules.save(
          this.rules.create({
            ...rule,
            channels: ['in_app'],
            recipients: [],
            enabled: true,
            last_triggered_at: null,
          }),
        );
      }
    }
  }

  public async list(): Promise<HealthAlertRule[]> {
    return await this.rules.find({ order: { severity: 'DESC', name: 'ASC' } });
  }

  public async update(
    id: string,
    patch: Partial<
      Pick<
        HealthAlertRule,
        | 'enabled'
        | 'threshold'
        | 'duration_seconds'
        | 'cooldown_seconds'
        | 'severity'
        | 'channels'
        | 'recipients'
      >
    >,
  ): Promise<HealthAlertRule> {
    const rule = await this.rules.findOneByOrFail({ id });
    Object.assign(rule, patch);
    rule.channels = rule.channels.filter((channel) => ['in_app', 'email'].includes(channel));
    rule.recipients = rule.recipients.slice(0, 20);
    return await this.rules.save(rule);
  }

  public async evaluate(components: HealthComponentResult[]): Promise<void> {
    const rules = await this.rules.findBy({ enabled: true });
    for (const rule of rules) {
      const candidates = components.filter((component) =>
        this.matchesComponent(rule.component_id, component.id),
      );
      for (const component of candidates) {
        const stateKey = `${rule.id}:${component.id}`;
        const value = this.metricValue(component, rule.metric);
        if (value === null || !this.compare(value, rule.operator, rule.threshold)) {
          this.firstExceededAt.delete(stateKey);
          continue;
        }
        const firstExceededAt = this.firstExceededAt.get(stateKey) ?? Date.now();
        this.firstExceededAt.set(stateKey, firstExceededAt);
        if (Date.now() - firstExceededAt < rule.duration_seconds * 1000) {
          continue;
        }
        const cooldownMs = rule.cooldown_seconds * 1000;
        if (rule.last_triggered_at && Date.now() - rule.last_triggered_at.getTime() < cooldownMs) {
          continue;
        }
        await this.deliver(rule, component, value);
        rule.last_triggered_at = new Date();
        await this.rules.save(rule);
        this.firstExceededAt.delete(stateKey);
        break;
      }
    }
  }

  /**
   * Hands the decided incident to the shared delivery path. The rule engine
   * (thresholds, `duration_seconds` hysteresis, persisted `cooldown_seconds`)
   * is unchanged and still lives entirely in this class; only the "how does a
   * human find out" half moved to `OperationalAlertService`, so rule-based
   * alerts and event-driven financial alerts share one destination.
   *
   * `rule.channels`/`rule.recipients` remain authoritative for the channels an
   * administrator explicitly configured. A `critical` rule additionally always
   * attempts the external destinations — the entire point of Phase 1 is that a
   * critical incident must not depend on someone watching the dashboard.
   */
  private async deliver(
    rule: HealthAlertRule,
    component: HealthComponentResult,
    value: number,
  ): Promise<void> {
    const isCritical = rule.severity === 'critical';
    await this.alerts.dispatch({
      key: `health-rule:${rule.key}:${component.id}`,
      severity: isCritical ? 'critical' : 'warning',
      title: rule.name,
      message: `${component.name}: ${rule.metric} is ${value.toFixed(2)} (threshold ${rule.threshold.toFixed(2)}).`,
      context: {
        componentId: component.id,
        alertRuleId: rule.id,
        metric: rule.metric,
        value: Number(value.toFixed(2)),
        threshold: rule.threshold,
      },
      additionalEmailRecipients: rule.recipients,
      channels: {
        inApp: rule.channels.includes('in_app'),
        email: isCritical || rule.channels.includes('email'),
        webhook: isCritical || rule.channels.includes('email'),
      },
    });
  }

  private matchesComponent(pattern: string | null, id: string): boolean {
    if (pattern === null) return true;
    if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1));
    return pattern === id;
  }

  private metricValue(component: HealthComponentResult, metric: string): number | null {
    if (metric === 'statusRank') {
      return {
        disabled: 0,
        healthy: 0,
        unknown: 1,
        warning: 2,
        misconfigured: 3,
        degraded: 4,
        down: 5,
      }[component.status];
    }
    const value = component.metadata[metric];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private compare(
    value: number,
    operator: HealthAlertRule['operator'],
    threshold: number,
  ): boolean {
    if (operator === 'gt') return value > threshold;
    if (operator === 'gte') return value >= threshold;
    if (operator === 'lt') return value < threshold;
    if (operator === 'lte') return value <= threshold;
    return value === threshold;
  }
}
