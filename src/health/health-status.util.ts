import type {
  HealthComponentResult,
  HealthImportance,
  HealthStatus,
  OverallHealthStatus,
} from './health.types';

const STATUS_SCORE: Record<HealthStatus, number> = {
  healthy: 100,
  warning: 85,
  degraded: 60,
  down: 0,
  misconfigured: 0,
  disabled: 100,
  unknown: 100,
};

const IMPORTANCE_WEIGHT: Record<HealthImportance, number> = {
  critical: 5,
  important: 2,
  optional: 0.5,
};

function importanceOf(component: HealthComponentResult): HealthImportance {
  return component.importance ?? (component.critical === true ? 'critical' : 'optional');
}

function requiredOf(component: HealthComponentResult): boolean {
  return component.required ?? importanceOf(component) !== 'optional';
}

export function calculateOverallStatus(components: HealthComponentResult[]): OverallHealthStatus {
  const active = components.filter((component) => component.status !== 'disabled');
  if (
    active.some(
      (component) =>
        importanceOf(component) === 'critical' &&
        requiredOf(component) &&
        ['down', 'misconfigured'].includes(component.status),
    )
  ) {
    return 'major_outage';
  }
  if (
    active.some(
      (component) =>
        importanceOf(component) === 'important' &&
        requiredOf(component) &&
        ['down', 'misconfigured'].includes(component.status),
    )
  ) {
    return 'partial_outage';
  }
  if (
    active.some(
      (component) =>
        (importanceOf(component) === 'critical' &&
          ['warning', 'degraded'].includes(component.status)) ||
        (importanceOf(component) === 'important' && component.status === 'degraded'),
    )
  ) {
    return 'degraded';
  }
  if (active.some((component) => component.status !== 'healthy')) {
    return 'operational_with_warnings';
  }
  return 'operational';
}

export function calculateHealthScore(components: HealthComponentResult[]): number {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const component of components) {
    if (component.status === 'disabled' || component.status === 'unknown') continue;
    const importance = importanceOf(component);
    if (component.status === 'misconfigured' && !requiredOf(component)) continue;
    const weight = IMPORTANCE_WEIGHT[importance];
    weightedScore += STATUS_SCORE[component.status] * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 100;
  return Math.max(0, Math.min(100, Math.round(weightedScore / totalWeight)));
}
