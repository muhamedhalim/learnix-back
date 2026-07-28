import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from '../activity-logs/entities';
import { NotificationsModule } from '../notifications/notifications.module';
import { User } from '../users/entities/user.entity';
import { HealthAlertRule, HealthErrorGroup, HealthIncident, HealthMetric } from './entities';
import { HealthAlertService } from './health-alert.service';
import { HealthAuditService } from './health-audit.service';
import { HealthCollectionService } from './health-collection.service';
import { HealthCollectorCoordinatorService } from './health-collector-coordinator.service';
import { HealthController } from './health.controller';
import { HealthDiagnosticsService } from './health-diagnostics.service';
import { HealthErrorService } from './health-error.service';
import { HealthIncidentService } from './health-incident.service';
import { HealthMetricsService } from './health-metrics.service';
import { HealthOrchestratorService } from './health-orchestrator.service';
import { HealthRiskService } from './health-risk.service';
import { HealthService } from './health.service';
import { BackendApiHealthIndicator } from './indicators/backend-api.indicator';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { DocumentHealthIndicator } from './indicators/document.indicator';
import { ExternalProvidersHealthIndicator } from './indicators/external-providers.indicator';
import { QueueHealthIndicator } from './indicators/queue.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { SchedulerHealthIndicator } from './indicators/scheduler.indicator';
import { StorageHealthIndicator } from './indicators/storage.indicator';

@Module({
  imports: [
    NotificationsModule,
    TypeOrmModule.forFeature([
      HealthMetric,
      HealthIncident,
      HealthAlertRule,
      HealthErrorGroup,
      AuditLog,
      User,
    ]),
  ],
  controllers: [HealthController],
  providers: [
    HealthService,
    HealthOrchestratorService,
    HealthMetricsService,
    HealthRiskService,
    HealthIncidentService,
    HealthErrorService,
    HealthAlertService,
    HealthAuditService,
    HealthDiagnosticsService,
    HealthCollectorCoordinatorService,
    HealthCollectionService,
    BackendApiHealthIndicator,
    DatabaseHealthIndicator,
    RedisHealthIndicator,
    QueueHealthIndicator,
    StorageHealthIndicator,
    ExternalProvidersHealthIndicator,
    DocumentHealthIndicator,
    SchedulerHealthIndicator,
  ],
  exports: [HealthService, HealthOrchestratorService],
})
export class HealthModule {}
