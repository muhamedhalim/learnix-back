import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { HealthAlertRule } from './entities';
import type { HealthComponentResult } from './health.types';
import { OperationalAlertService } from './operational-alert.service';
import { seedHealthAlertRules } from '../database/system-seed';
import { biBody } from '../i18n/error-translator.util';

@Injectable()
export class HealthAlertService implements OnModuleInit {
  private readonly firstExceededAt = new Map<string, number>();
  constructor(
    @InjectRepository(HealthAlertRule)
    private readonly rules: Repository<HealthAlertRule>,
    private readonly alerts: OperationalAlertService,
  ) {}

  public async onModuleInit(): Promise<void> {
    await seedHealthAlertRules(this.rules.manager);
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
    // `findOneByOrFail` would throw a raw EntityNotFoundError, which surfaces as a 500.
    const rule = await this.rules.findOneBy({ id });
    if (rule === null) {
      throw new NotFoundException(biBody('Alert rule not found', 'قاعدة التنبيه غير موجودة'));
    }
    // The validated DTO carries every omitted field as an own key set to `undefined`; copying those
    // would blank `channels`/`recipients` and crash the sanitising below on a partial update.
    Object.assign(
      rule,
      Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    );
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
      // Threshold/health rules are monitoring signals. They surface on the
      // health console (incidents), email and the webhook — never in the admin
      // business inbox. `rule.channels` 'in_app' therefore has no inbox effect.
      audience: 'technical',
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
