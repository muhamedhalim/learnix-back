import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';

import { healthCollectionState } from './health-collection.state';
import { HealthAlertService } from './health-alert.service';
import { HealthErrorService } from './health-error.service';
import { HealthIncidentService } from './health-incident.service';
import { HealthMetricsService } from './health-metrics.service';
import { HealthOrchestratorService } from './health-orchestrator.service';
import { sanitiseMessage } from './health-sanitizer.util';
import type { HealthDashboardResponse } from './health.types';

@Injectable()
export class HealthCollectionService {
  private readonly logger = new Logger(HealthCollectionService.name);

  constructor(
    private readonly orchestrator: HealthOrchestratorService,
    private readonly metrics: HealthMetricsService,
    private readonly incidents: HealthIncidentService,
    private readonly alerts: HealthAlertService,
    private readonly errors: HealthErrorService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  @Timeout(2_000)
  public async collect(): Promise<HealthDashboardResponse | null> {
    if (healthCollectionState.running) return null;
    healthCollectionState.running = true;
    healthCollectionState.lastStartedAt = new Date();
    try {
      const dashboard = await this.orchestrator.dashboard(true);
      await this.metrics.record(dashboard.components);
      await Promise.allSettled([
        this.incidents.evaluate(dashboard.components),
        this.alerts.evaluate(dashboard.components),
        this.errors.recordComponents(dashboard.components),
      ]);
      healthCollectionState.lastCompletedAt = new Date();
      return dashboard;
    } catch (error) {
      healthCollectionState.lastFailedAt = new Date();
      this.logger.error(`Scheduled health collection failed: ${sanitiseMessage(error)}`);
      return null;
    } finally {
      healthCollectionState.running = false;
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  public async aggregate(): Promise<void> {
    try {
      await this.metrics.aggregateAndRetain();
    } catch (error) {
      this.logger.error(`Health metric aggregation failed: ${sanitiseMessage(error)}`);
    }
  }
}
