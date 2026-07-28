import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { sanitiseMessage, sanitiseMetadata } from './health-sanitizer.util';
import { withHealthTimeout } from './health-timeout.util';
import { calculateHealthScore, calculateOverallStatus } from './health-status.util';
import type {
  HealthComponentResult,
  HealthDashboardResponse,
  HealthDependencyEdge,
  HealthStatus,
  OverallHealthStatus,
} from './health.types';
import { HealthMetricsService } from './health-metrics.service';
import { HealthRiskService } from './health-risk.service';
import { BackendApiHealthIndicator } from './indicators/backend-api.indicator';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { DocumentHealthIndicator } from './indicators/document.indicator';
import { ExternalProvidersHealthIndicator } from './indicators/external-providers.indicator';
import { QueueHealthIndicator } from './indicators/queue.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { SchedulerHealthIndicator } from './indicators/scheduler.indicator';
import { StorageHealthIndicator } from './indicators/storage.indicator';

interface IndicatorRunner {
  id: string;
  check(force?: boolean): Promise<HealthComponentResult | HealthComponentResult[]>;
}

@Injectable()
export class HealthOrchestratorService {
  private readonly logger = new Logger(HealthOrchestratorService.name);
  private readonly cacheTtlMs: number;
  private readonly checkTimeoutMs: number;
  private cache: { value: HealthDashboardResponse; expiresAt: number } | null = null;
  private activeCheck: Promise<HealthDashboardResponse> | null = null;
  private lastSuccessfulFullCheck: string | null = null;
  private readonly indicators: IndicatorRunner[];

  constructor(
    backend: BackendApiHealthIndicator,
    database: DatabaseHealthIndicator,
    redis: RedisHealthIndicator,
    queues: QueueHealthIndicator,
    storage: StorageHealthIndicator,
    providers: ExternalProvidersHealthIndicator,
    document: DocumentHealthIndicator,
    scheduler: SchedulerHealthIndicator,
    private readonly metrics: HealthMetricsService,
    private readonly risks: HealthRiskService,
    private readonly config: ConfigService,
  ) {
    this.indicators = [backend, database, redis, queues, storage, providers, document, scheduler];
    this.cacheTtlMs = Number(this.config.get<string>('HEALTH_CACHE_TTL_MS')) || 20_000;
    this.checkTimeoutMs = Number(this.config.get<string>('HEALTH_CHECK_TIMEOUT_MS')) || 12_000;
  }

  public async dashboard(force = false): Promise<HealthDashboardResponse> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) {
      return {
        ...this.cache.value,
        summary: {
          ...this.cache.value.summary,
          monitoring: {
            ...this.cache.value.summary.monitoring,
            cached: true,
          },
        },
      };
    }
    if (this.activeCheck) return await this.activeCheck;
    this.activeCheck = this.execute();
    try {
      return await this.activeCheck;
    } finally {
      this.activeCheck = null;
    }
  }

  public async recheck(componentId: string): Promise<HealthComponentResult> {
    const indicator = this.indicators.find(
      (candidate) =>
        candidate.id === componentId ||
        (componentId.startsWith('queue-') && candidate.id === 'background-queues') ||
        ([
          'frontend-web',
          'jwt-authentication',
          'mailersend-email',
          'easykash',
          'firebase',
          'meta-whatsapp',
          'twilio-sms',
          'bunny-stream',
          'sentry',
        ].includes(componentId) &&
          candidate.id === 'external-providers'),
    );
    if (!indicator) {
      throw new Error('Unknown health component');
    }
    const output = await withHealthTimeout(
      indicator.id,
      indicator.check(true),
      this.checkTimeoutMs,
    );
    const components = this.sanitise(Array.isArray(output) ? output : [output]);
    const match = components.find((component) => component.id === componentId);
    if (!match) throw new Error('Health component did not return a result');
    return match;
  }

  public readinessFrom(dashboard: HealthDashboardResponse): 'ready' | 'not_ready' {
    return dashboard.components.some(
      (component) =>
        component.critical === true && ['down', 'misconfigured'].includes(component.status),
    )
      ? 'not_ready'
      : 'ready';
  }

  private async execute(): Promise<HealthDashboardResponse> {
    const batches = await this.runWithConcurrency(this.indicators, 4);
    let components = this.sanitise(batches.flat());
    try {
      components = await this.metrics.enrich(components);
    } catch (error) {
      this.logger.warn(`Health history enrichment unavailable: ${sanitiseMessage(error)}`);
    }

    const overall = calculateOverallStatus(components);
    const score = calculateHealthScore(components);
    if (overall === 'operational') {
      this.lastSuccessfulFullCheck = new Date().toISOString();
    }
    let riskResult = { risks: [], historyAvailable: false } as Awaited<
      ReturnType<HealthRiskService['evaluate']>
    >;
    let uptime = {
      last24Hours: null,
      last7Days: null,
      last30Days: null,
    } as HealthDashboardResponse['summary']['uptime'];
    try {
      riskResult = await this.risks.evaluate(components);
    } catch (error) {
      this.logger.warn(`Risk history unavailable: ${sanitiseMessage(error)}`);
    }
    try {
      uptime = await this.metrics.uptimeWindows(
        components
          .filter((component) => component.critical === true)
          .map((component) => component.id),
      );
    } catch (error) {
      this.logger.warn(`Uptime history unavailable: ${sanitiseMessage(error)}`);
    }
    const counts = {
      healthy: 0,
      warning: 0,
      degraded: 0,
      down: 0,
      misconfigured: 0,
      unknown: 0,
    } satisfies Record<HealthStatus, number>;
    for (const component of components) counts[component.status]++;

    const dashboard: HealthDashboardResponse = {
      summary: {
        status: overall,
        score,
        banner: this.banner(overall, components),
        environment: this.config.get<string>('NODE_ENV') ?? 'development',
        backendVersion: this.config.get<string>('APP_VERSION') ?? '0.0.1',
        frontendVersion: this.config.get<string>('FRONTEND_VERSION') ?? null,
        deploymentId:
          this.config.get<string>('RAILWAY_GIT_COMMIT_SHA') ??
          this.config.get<string>('GIT_COMMIT') ??
          this.config.get<string>('RENDER_GIT_COMMIT') ??
          null,
        serverTime: new Date().toISOString(),
        timezone: this.config.get<string>('TZ') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        lastSuccessfulFullCheck: this.lastSuccessfulFullCheck,
        monitoring: {
          refreshing: this.activeCheck !== null,
          intervalSeconds: 60,
          cached: false,
        },
        uptime,
        counts,
      },
      components,
      dependencyMap: this.dependencyMap(components),
      risks: riskResult.risks,
      historyAvailable: riskResult.historyAvailable,
      generatedAt: new Date().toISOString(),
    };
    this.cache = {
      value: dashboard,
      expiresAt: Date.now() + this.cacheTtlMs,
    };
    return dashboard;
  }

  private async runWithConcurrency(
    indicators: IndicatorRunner[],
    concurrency: number,
  ): Promise<HealthComponentResult[][]> {
    const results = new Array<HealthComponentResult[]>(indicators.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < indicators.length) {
        const index = cursor++;
        const indicator = indicators[index]!;
        const startedAt = Date.now();
        try {
          const output = await withHealthTimeout(
            indicator.id,
            indicator.check(),
            this.checkTimeoutMs,
          );
          results[index] = Array.isArray(output) ? output : [output];
        } catch (error) {
          results[index] = [
            {
              id: indicator.id,
              name: indicator.id,
              category: 'application',
              status: 'unknown',
              latencyMs: Date.now() - startedAt,
              checkedAt: new Date().toISOString(),
              lastSuccessAt: null,
              failureCount: 1,
              availabilityPercent: null,
              message: sanitiseMessage(error),
              metadata: {},
              warnings: ['The health indicator did not complete.'],
              errorCode: 'HEALTH_INDICATOR_FAILED',
              dependencies: [],
              recommendation: 'Retry the component check and inspect backend logs.',
            },
          ];
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, indicators.length) }, worker));
    return results;
  }

  private sanitise(components: HealthComponentResult[]): HealthComponentResult[] {
    return components.map((component) => ({
      ...component,
      message: sanitiseMessage(component.message),
      metadata: sanitiseMetadata(component.metadata),
      warnings: component.warnings.map(sanitiseMessage),
      recommendation:
        component.recommendation === null ? null : sanitiseMessage(component.recommendation),
    }));
  }

  private banner(overall: OverallHealthStatus, components: HealthComponentResult[]): string {
    const priority: Record<HealthStatus, number> = {
      down: 5,
      degraded: 4,
      misconfigured: 3,
      warning: 2,
      unknown: 1,
      healthy: 0,
    };
    const issues = components
      .filter((component) => component.status !== 'healthy')
      .sort((a, b) => {
        const critical = Number(b.critical === true) - Number(a.critical === true);
        return critical || priority[b.status] - priority[a.status];
      });
    if (issues.length === 0) {
      return 'All monitored Learnix components are connected and operating within safe thresholds.';
    }
    const leading = issues.slice(0, 2);
    const names = leading.map((component) => component.name).join(' and ');
    const prefix =
      overall === 'operational'
        ? 'Platform is operational'
        : overall === 'degraded'
          ? 'Platform performance is degraded'
          : overall === 'partial_outage'
            ? 'Platform has a partial outage'
            : 'Platform has a major outage';
    return `${prefix}; ${names} ${leading.length === 1 ? 'requires' : 'require'} attention. ${leading[0]!.message}`;
  }

  private dependencyMap(components: HealthComponentResult[]): {
    nodes: HealthDashboardResponse['dependencyMap']['nodes'];
    edges: HealthDependencyEdge[];
  } {
    const byId = new Map(components.map((component) => [component.id, component]));
    return {
      nodes: components.map((component) => ({
        id: component.id,
        label: component.name,
        category: component.category,
        status: component.status,
        latencyMs: component.latencyMs,
      })),
      edges: components.flatMap((component) =>
        component.dependencies.map((dependency) => ({
          from: component.id,
          to: dependency,
          status: byId.get(dependency)?.status ?? 'unknown',
          impact: `${component.name} depends on ${byId.get(dependency)?.name ?? dependency}.`,
        })),
      ),
    };
  }
}
