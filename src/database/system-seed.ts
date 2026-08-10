import type { EntityManager } from 'typeorm';

import { RANK_TIER_SEEDS } from '../gamification/gamification.constants';
import { RankTier } from '../gamification/entities';
import { HealthAlertRule } from '../health/entities';

export const DEFAULT_HEALTH_ALERT_RULES: ReadonlyArray<
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
] as const;

export interface SystemSeedSummary {
  rank_tiers: number;
  health_alert_rules: number;
}

export async function seedRankTiers(manager: EntityManager): Promise<number> {
  const ranks = manager.getRepository(RankTier);
  for (const seed of RANK_TIER_SEEDS) {
    if (!(await ranks.existsBy({ slug: seed.slug }))) {
      await ranks.save(
        ranks.create({
          slug: seed.slug,
          name: seed.name,
          icon_key: seed.icon_key,
          color: seed.color,
          min_rating: seed.min_rating,
          min_xp: seed.min_xp,
          sort_order: seed.order,
        }),
      );
    }
  }
  return await ranks.count();
}

export async function seedHealthAlertRules(manager: EntityManager): Promise<number> {
  const rules = manager.getRepository(HealthAlertRule);
  for (const rule of DEFAULT_HEALTH_ALERT_RULES) {
    if (!(await rules.existsBy({ key: rule.key }))) {
      await rules.save(
        rules.create({
          ...rule,
          channels: ['in_app'],
          recipients: [],
          enabled: true,
          last_triggered_at: null,
        }),
      );
    }
  }
  return await rules.count();
}

/**
 * Recreate code-defined reference/configuration rows without touching user-
 * managed business data. Each insert is conflict-safe so normal application
 * startup and an accidentally repeated maintenance seed cannot duplicate rows.
 */
export async function seedRequiredSystemData(manager: EntityManager): Promise<SystemSeedSummary> {
  return {
    rank_tiers: await seedRankTiers(manager),
    health_alert_rules: await seedHealthAlertRules(manager),
  };
}
