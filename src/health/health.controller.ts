import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { THROTTLE } from '../common/constants';
import { Roles } from '../common/decorators/roles.decorator';
import type { UserRequest } from '../common/interfaces/user-request.interface';
import {
  HealthHistoryQueryDto,
  HealthListQueryDto,
  QueueDiagnosticActionDto,
  UpdateHealthAlertRuleDto,
} from './dto/health.dto';
import { HealthAlertService } from './health-alert.service';
import { HealthAuditService } from './health-audit.service';
import { HealthDiagnosticsService } from './health-diagnostics.service';
import { HealthErrorService } from './health-error.service';
import { HealthIncidentService } from './health-incident.service';
import { HealthMetricsService } from './health-metrics.service';
import { HealthOrchestratorService } from './health-orchestrator.service';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly orchestrator: HealthOrchestratorService,
    private readonly metrics: HealthMetricsService,
    private readonly incidents: HealthIncidentService,
    private readonly errors: HealthErrorService,
    private readonly alerts: HealthAlertService,
    private readonly audit: HealthAuditService,
    private readonly diagnostics: HealthDiagnosticsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Public liveness probe' })
  public liveness(): { status: 'healthy'; timestamp: string } {
    return this.health.getPublicLiveness();
  }

  @Get('version')
  @ApiOperation({ summary: 'Public build identity (commit SHA) for deploy verification' })
  public version(): { commit: string | null } {
    return this.health.getPublicVersion();
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Minimal readiness probe' })
  public async readiness(@Res({ passthrough: true }) response: Response): Promise<unknown> {
    const readiness = await this.health.getReadiness();
    if (readiness.status === 'not_ready') {
      response.status(new ServiceUnavailableException().getStatus());
    }
    return readiness;
  }

  @Get('all')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Detailed system health dashboard (Admin only)' })
  public async dashboard(): Promise<unknown> {
    return await this.orchestrator.dashboard(false);
  }

  @Get('summary')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Compact cached system health summary (Admin only)' })
  public async dashboardSummary(): Promise<unknown> {
    const dashboard = await this.orchestrator.dashboard(false);
    return {
      status: dashboard.summary.status,
      score: dashboard.summary.score,
      counts: dashboard.summary.counts,
      generatedAt: dashboard.generatedAt,
    };
  }

  @Get('metrics')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  public async metricHistory(@Query() query: HealthHistoryQueryDto): Promise<unknown> {
    const componentIds = query.components
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 30);
    return await this.metrics.history(query.range, componentIds);
  }

  @Get('errors')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  public async recentErrors(@Query() query: HealthListQueryDto): Promise<unknown> {
    return await this.errors.list(query);
  }

  @Get('incidents')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  public async incidentHistory(@Query() query: HealthListQueryDto): Promise<unknown> {
    return await this.incidents.list(query.page, query.limit);
  }

  @Get('alerts')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  public async alertRules(): Promise<unknown> {
    return await this.alerts.list();
  }

  @Patch('alerts/:id')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @Throttle({ default: THROTTLE.DEFAULT })
  public async updateAlertRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateHealthAlertRuleDto,
    @Req() request: UserRequest,
  ): Promise<unknown> {
    const updated = await this.alerts.update(id, body);
    await this.audit.record({
      adminId: this.adminId(request),
      action: 'health_alert_rule_updated',
      target: updated.key,
      details: {
        enabled: updated.enabled,
        threshold: updated.threshold,
        durationSeconds: updated.duration_seconds,
        cooldownSeconds: updated.cooldown_seconds,
        channels: updated.channels,
      },
      ipAddress: request.ip,
    });
    return updated;
  }

  @Post('actions/run')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @Throttle({ default: THROTTLE.STRICT })
  public async runFull(@Req() request: UserRequest): Promise<unknown> {
    return await this.diagnostics.runFull({
      adminId: this.adminId(request),
      ipAddress: request.ip,
    });
  }

  @Post('components/:id/recheck')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @Throttle({ default: THROTTLE.DEFAULT })
  public async recheck(@Param('id') id: string, @Req() request: UserRequest): Promise<unknown> {
    return await this.diagnostics.recheck({
      componentId: id,
      adminId: this.adminId(request),
      ipAddress: request.ip,
    });
  }

  @Post('actions/test-email')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @Throttle({ default: THROTTLE.STRICT })
  public async testEmail(@Req() request: UserRequest): Promise<unknown> {
    return await this.diagnostics.testEmail({
      adminId: this.adminId(request),
      adminEmail: request.user?.email ?? '',
      ipAddress: request.ip,
    });
  }

  @Post('queues/:name/action')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @Throttle({ default: THROTTLE.STRICT })
  public async queueAction(
    @Param('name') name: string,
    @Body() body: QueueDiagnosticActionDto,
    @Req() request: UserRequest,
  ): Promise<unknown> {
    return await this.diagnostics.queueAction({
      queueName: name,
      action: body.action,
      confirm: body.confirm,
      adminId: this.adminId(request),
      ipAddress: request.ip,
    });
  }

  @Post('actions/export')
  @Header('Content-Disposition', 'attachment; filename="learnix-health-report.json"')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @Throttle({ default: THROTTLE.DEFAULT })
  public async exportReport(@Req() request: UserRequest): Promise<unknown> {
    return await this.diagnostics.exportReport({
      adminId: this.adminId(request),
      ipAddress: request.ip,
    });
  }

  private adminId(request: UserRequest): string {
    if (!request.user?.userId) throw new Error('Authenticated administrator required');
    return request.user.userId;
  }
}
