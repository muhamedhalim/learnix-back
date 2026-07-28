import type {
  HealthCategory,
  HealthComponentResult,
  HealthDependencyType,
  HealthImportance,
  HealthStatus,
} from '../health.types';

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
  dependencyTypes?: Partial<Record<string, HealthDependencyType>>;
  recommendation?: string | null;
  critical?: boolean;
  importance?: HealthImportance;
  required?: boolean;
}): HealthComponentResult {
  const checkedAt = new Date().toISOString();
  const successful = ['healthy', 'warning', 'degraded'].includes(input.status);
  return {
    id: input.id,
    name: input.name,
    category: input.category,
    status: input.status,
    latencyMs: Math.max(0, Date.now() - input.startedAt),
    checkedAt,
    lastSuccessAt: successful ? checkedAt : null,
    failureCount: ['down', 'misconfigured'].includes(input.status) ? 1 : 0,
    availabilityPercent: null,
    message: input.message,
    metadata: input.metadata ?? {},
    warnings: input.warnings ?? [],
    errorCode: input.errorCode ?? null,
    dependencies: input.dependencies ?? [],
    ...(input.dependencyTypes === undefined ? {} : { dependencyTypes: input.dependencyTypes }),
    recommendation: input.recommendation ?? null,
    ...(input.critical === undefined ? {} : { critical: input.critical }),
    importance: input.importance ?? (input.critical === true ? 'critical' : 'optional'),
    required:
      input.required ??
      (input.importance === 'critical' ||
        input.importance === 'important' ||
        input.critical === true),
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
