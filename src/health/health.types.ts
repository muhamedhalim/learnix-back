export type HealthStatus =
  | 'healthy'
  | 'warning'
  | 'degraded'
  | 'down'
  | 'misconfigured'
  | 'disabled'
  | 'unknown';

export type OverallHealthStatus =
  | 'operational'
  | 'operational_with_warnings'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage';

export type HealthImportance = 'critical' | 'important' | 'optional';
export type HealthDependencyType = 'direct' | 'operational' | 'optional';

export interface MonitoringCoverage {
  state: 'available' | 'unavailable' | 'insufficient_data' | 'no_data' | 'disabled';
  observedPeriodSeconds: number | null;
  expectedSamples: number;
  collectedSamples: number;
  eligibleSamples: number;
  missedSamples: number;
  coveragePercent: number | null;
  minimumSamples: number;
}

export interface HealthDiagnostics {
  summary: string;
  measuredValues: Record<string, unknown>;
  thresholds: Record<string, number | string>;
  reasonCode: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  recentFailureCount: number;
  monitoringCoverage: MonitoringCoverage;
  recommendedAction: string | null;
}

export type HealthCategory =
  | 'application'
  | 'database'
  | 'cache'
  | 'queue'
  | 'storage'
  | 'provider'
  | 'authentication'
  | 'document'
  | 'scheduler'
  | 'monitoring';

export interface HealthComponentResult {
  id: string;
  name: string;
  category: HealthCategory;
  status: HealthStatus;
  latencyMs: number | null;
  checkedAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  availabilityPercent: number | null;
  message: string;
  metadata: Record<string, unknown>;
  warnings: string[];
  errorCode: string | null;
  dependencies: string[];
  dependencyTypes?: Partial<Record<string, HealthDependencyType>>;
  recommendation: string | null;
  critical?: boolean;
  importance?: HealthImportance;
  required?: boolean;
  monitoringCoverage?: MonitoringCoverage;
  lastFailureAt?: string | null;
  diagnostics?: HealthDiagnostics;
}

export interface HealthDependencyNode {
  id: string;
  label: string;
  category: HealthCategory;
  status: HealthStatus;
  latencyMs: number | null;
}

export interface HealthDependencyEdge {
  from: string;
  to: string;
  status: HealthStatus;
  impact: string;
  type: HealthDependencyType;
}

export interface HealthRisk {
  id: string;
  level: 'low' | 'medium' | 'high' | 'critical';
  componentId: string;
  title: string;
  evidence: string;
  currentValue: number;
  threshold: number;
  trend: 'rising' | 'falling' | 'stable';
  estimatedImpact: string;
  recommendedAction: string;
  confidencePercent: number;
  timeWindow: string;
}

export interface HealthSummary {
  status: OverallHealthStatus;
  score: number;
  banner: string;
  environment: string;
  backendVersion: string;
  frontendVersion: string | null;
  deploymentId: string | null;
  serverTime: string;
  timezone: string;
  lastSuccessfulFullCheck: string | null;
  monitoring: {
    refreshing: boolean;
    intervalSeconds: number;
    cached: boolean;
  };
  uptime: {
    last24Hours: number | null;
    last7Days: number | null;
    last30Days: number | null;
  };
  counts: Record<HealthStatus, number>;
}

export interface HealthDashboardResponse {
  summary: HealthSummary;
  components: HealthComponentResult[];
  dependencyMap: {
    nodes: HealthDependencyNode[];
    edges: HealthDependencyEdge[];
  };
  risks: HealthRisk[];
  historyAvailable: boolean;
  generatedAt: string;
}

export interface HealthMetricPoint {
  timestamp: string;
  componentId: string;
  status: HealthStatus;
  latencyMs: number | null;
  metrics: Record<string, number>;
}

export interface DiagnosticActionResult {
  action: string;
  status: 'completed' | 'failed' | 'skipped';
  startedAt: string;
  completedAt: string;
  message: string;
  component?: HealthComponentResult;
}
