import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';

import { HealthAlertService } from './health-alert.service';
import { HealthCollectorCoordinatorService } from './health-collector-coordinator.service';
import { HealthErrorService } from './health-error.service';
import { HealthIncidentService } from './health-incident.service';
import { HealthMetricsService } from './health-metrics.service';
import { HealthOrchestratorService } from './health-orchestrator.service';
import { sanitiseMessage } from './health-sanitizer.util';
import type { HealthDashboardResponse } from './health.types';

@Injectable()
export class HealthCollectionService {
  private readonly logger = new Logger(HealthCollectionService.name);
  private lastOutcome: 'completed' | 'failed' | 'skipped' = 'skipped';

  constructor(
    private readonly orchestrator: HealthOrchestratorService,
    private readonly metrics: HealthMetricsService,
    private readonly incidents: HealthIncidentService,
    private readonly alerts: HealthAlertService,
    private readonly errors: HealthErrorService,
    private readonly coordinator: HealthCollectorCoordinatorService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  @Timeout(2_000)
  public async collect(): Promise<HealthDashboardResponse | null> {
    const identity = this.coordinator.getIdentity();
    const lease = await this.coordinator.acquireLease('collection');
    if (typeof lease === 'string') {
      this.lastOutcome = 'skipped';
      await this.coordinator.recordSkipped(lease);
      this.logger.log(
        JSON.stringify({
          event: 'health_collection_skipped',
          skipped_at: new Date().toISOString(),
          collection_version: identity.collectionVersion,
          instance_id: identity.instanceId,
          process_role: identity.processRole,
          reason: lease,
        }),
      );
      return null;
    }

    const startedAt = new Date();
    await this.coordinator.recordStarted(startedAt);
    this.logger.log(
      JSON.stringify({
        event: 'health_collection_started',
        started_at: startedAt.toISOString(),
        collection_version: identity.collectionVersion,
        instance_id: identity.instanceId,
        process_role: identity.processRole,
      }),
    );
    try {
      const dashboard = await this.orchestrator.dashboard(true);
      await this.metrics.record(dashboard.components);
      await Promise.allSettled([
        this.incidents.evaluate(dashboard.components),
        this.alerts.evaluate(dashboard.components),
        this.errors.recordComponents(dashboard.components),
      ]);
      const completedAt = new Date();
      await this.coordinator.recordCompleted(startedAt, completedAt);
      this.lastOutcome = 'completed';
      this.logger.log(
        JSON.stringify({
          event: 'health_collection_completed',
          started_at: startedAt.toISOString(),
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          collection_version: identity.collectionVersion,
          instance_id: identity.instanceId,
          process_role: identity.processRole,
        }),
      );
      return dashboard;
    } catch (error) {
      const failedAt = new Date();
      const category = this.errorCategory(error);
      await this.coordinator.recordFailed(startedAt, failedAt, category);
      this.lastOutcome = 'failed';
      this.logger.error(
        JSON.stringify({
          event: 'health_collection_failed',
          started_at: startedAt.toISOString(),
          failed_at: failedAt.toISOString(),
          duration_ms: failedAt.getTime() - startedAt.getTime(),
          collection_version: identity.collectionVersion,
          instance_id: identity.instanceId,
          process_role: identity.processRole,
          last_error_category: category,
          message: sanitiseMessage(error),
        }),
      );
      return null;
    } finally {
      await lease.release();
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  public async aggregate(): Promise<void> {
    const lease = await this.coordinator.acquireLease('aggregation');
    if (typeof lease === 'string') return;
    try {
      await this.metrics.aggregateAndRetain();
    } catch (error) {
      this.logger.error(`Health metric aggregation failed: ${sanitiseMessage(error)}`);
    } finally {
      await lease.release();
    }
  }

  public getLastOutcome(): 'completed' | 'failed' | 'skipped' {
    return this.lastOutcome;
  }

  private errorCategory(error: unknown): string {
    const candidate = error as { code?: unknown; name?: unknown };
    return String(candidate.code ?? candidate.name ?? 'UNKNOWN')
      .replaceAll(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 80);
  }
}
