import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { MailService } from '../mail/mail.service';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
import { UserRole } from '../users/entities/user-role.enum';
import { User } from '../users/entities/user.entity';
import { HealthAlertRule } from './entities';
import type { HealthComponentResult } from './health.types';

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
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
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

  private async deliver(
    rule: HealthAlertRule,
    component: HealthComponentResult,
    value: number,
  ): Promise<void> {
    const title = `[${rule.severity.toUpperCase()}] ${rule.name}`;
    const message = `${component.name}: ${rule.metric} is ${value.toFixed(2)} (threshold ${rule.threshold.toFixed(2)}).`;
    if (rule.channels.includes('in_app')) {
      const admins = await this.users.find({
        where: { role: UserRole.ADMIN, is_active: true },
        select: { id: true },
        take: 100,
      });
      await Promise.allSettled(
        admins.map(
          async (admin) =>
            await this.notifications.create(
              {
                user_id: admin.id,
                type: NotificationType.CUSTOM,
                title,
                message,
                data: { componentId: component.id, alertRuleId: rule.id },
              },
              false,
            ),
        ),
      );
    }
    if (rule.channels.includes('email') && this.mail.isConfigured()) {
      await Promise.allSettled(
        rule.recipients
          .filter((recipient) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient))
          .map(
            async (recipient) =>
              await this.mail.send({
                to: recipient,
                subject: title,
                text: message,
                html: `<p>${message}</p>`,
              }),
          ),
      );
    }
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
