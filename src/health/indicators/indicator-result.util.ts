import type { HealthCategory, HealthComponentResult, HealthStatus } from '../health.types';

export function componentResult(input: {
  id: string;
  name: string;
  category: HealthCategory;
  status: HealthStatus;
  startedAt: number;
  message: string;
  metadata?: Record<string, unknown>;
  warnings?: string[];
  errorCode?: string | null;
  dependencies?: string[];
  recommendation?: string | null;
  critical?: boolean;
}): HealthComponentResult {
  const checkedAt = new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    category: input.category,
    status: input.status,
    latencyMs: Math.max(0, Date.now() - input.startedAt),
    checkedAt,
    lastSuccessAt: input.status === 'healthy' ? checkedAt : null,
    failureCount: input.status === 'healthy' ? 0 : 1,
    availabilityPercent: null,
    message: input.message,
    metadata: input.metadata ?? {},
    warnings: input.warnings ?? [],
    errorCode: input.errorCode ?? null,
    dependencies: input.dependencies ?? [],
    recommendation: input.recommendation ?? null,
    ...(input.critical === undefined ? {} : { critical: input.critical }),
  };
}

export function statusForLatency(
  latencyMs: number,
  warningMs: number,
  degradedMs: number,
): HealthStatus {
  if (latencyMs >= degradedMs) return 'degraded';
  if (latencyMs >= warningMs) return 'warning';
  return 'healthy';
}
