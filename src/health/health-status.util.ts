import type { HealthComponentResult, HealthStatus, OverallHealthStatus } from './health.types';

const STATUS_SCORE: Record<HealthStatus, number> = {
  healthy: 100,
  warning: 82,
  unknown: 60,
  misconfigured: 45,
  degraded: 30,
  down: 0,
};

export function calculateOverallStatus(components: HealthComponentResult[]): OverallHealthStatus {
  const criticalDown = components.filter(
    (component) =>
      component.critical === true && ['down', 'misconfigured'].includes(component.status),
  ).length;
  const criticalDegraded = components.filter(
    (component) => component.critical === true && component.status === 'degraded',
  ).length;
  const criticalWarning = components.some(
    (component) => component.critical === true && component.status === 'warning',
  );
  const nonCriticalOutages = components.filter(
    (component) => component.critical !== true && ['down', 'degraded'].includes(component.status),
  ).length;
  if (criticalDown >= 2) return 'major_outage';
  if (criticalDown === 1 || criticalDegraded > 0) return 'partial_outage';
  if (criticalWarning || nonCriticalOutages >= 2) return 'degraded';
  return 'operational';
}

export function calculateHealthScore(components: HealthComponentResult[]): number {
  if (components.length === 0) return 0;
  let weightedScore = 0;
  let totalWeight = 0;
  for (const component of components) {
    const weight = component.critical === true ? 2 : 0.6;
    weightedScore += STATUS_SCORE[component.status] * weight;
    totalWeight += weight;
  }
  return Math.max(0, Math.min(100, Math.round(weightedScore / totalWeight)));
}
