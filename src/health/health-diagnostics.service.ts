import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Queue } from 'bullmq';

import { resolveRedisUrl } from '../common/utils/redis-connection.util';
import { MailService } from '../mail/mail.service';
import { QUEUE_NAMES } from '../queues/queues.constants';
import { HealthAlertService } from './health-alert.service';
import { HealthAuditService } from './health-audit.service';
import { HealthCollectionService } from './health-collection.service';
import { HealthErrorService } from './health-error.service';
import { HealthIncidentService } from './health-incident.service';
import { HealthMetricsService } from './health-metrics.service';
import { HealthOrchestratorService } from './health-orchestrator.service';
import { sanitiseMessage } from './health-sanitizer.util';
import type { DiagnosticActionResult } from './health.types';

@Injectable()
export class HealthDiagnosticsService {
  constructor(
    private readonly orchestrator: HealthOrchestratorService,
    private readonly collection: HealthCollectionService,
    private readonly metrics: HealthMetricsService,
    private readonly incidents: HealthIncidentService,
    private readonly alerts: HealthAlertService,
    private readonly errors: HealthErrorService,
    private readonly audit: HealthAuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  public async runFull(input: {
    adminId: string;
    ipAddress?: string | null | undefined;
  }): Promise<DiagnosticActionResult> {
    const startedAt = new Date();
    const dashboard = await this.collection.collect();
    await this.audit.record({
      adminId: input.adminId,
      action: 'health_full_check_run',
      target: 'system',
      details: {
        status: dashboard?.summary.status ?? 'already_running',
        score: dashboard?.summary.score ?? null,
      },
      ipAddress: input.ipAddress,
    });
    return {
      action: 'run_full_health_check',
      status: dashboard ? 'completed' : 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      message: dashboard
        ? dashboard.summary.banner
        : 'A health collection is already running or did not complete.',
    };
  }

  public async recheck(input: {
    componentId: string;
    adminId: string;
    ipAddress?: string | null | undefined;
  }): Promise<DiagnosticActionResult> {
    const startedAt = new Date();
    try {
      const component = await this.orchestrator.recheck(input.componentId);
      await this.metrics.record([component]);
      await Promise.allSettled([
        this.incidents.evaluate([component]),
        this.alerts.evaluate([component]),
        this.errors.recordComponents([component]),
      ]);
      await this.audit.record({
        adminId: input.adminId,
        action: 'health_component_rechecked',
        target: input.componentId,
        details: { status: component.status, errorCode: component.errorCode },
        ipAddress: input.ipAddress,
      });
      return {
        action: 'recheck_component',
        status: 'completed',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        message: component.message,
        component,
      };
    } catch (error) {
      await this.audit.record({
        adminId: input.adminId,
        action: 'health_component_recheck_failed',
        target: input.componentId,
        details: { error: sanitiseMessage(error) },
        ipAddress: input.ipAddress,
      });
      return {
        action: 'recheck_component',
        status: 'failed',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        message: sanitiseMessage(error),
      };
    }
  }

  public async testEmail(input: {
    adminId: string;
    adminEmail: string;
    ipAddress?: string | null | undefined;
  }): Promise<DiagnosticActionResult> {
    const startedAt = new Date();
    const sent = await this.mail.sendHealthCheckEmail(input.adminEmail);
    await this.audit.record({
      adminId: input.adminId,
      action: 'health_test_email',
      target: 'mailersend-email',
      details: { sent },
      ipAddress: input.ipAddress,
    });
    return {
      action: 'test_email',
      status: sent ? 'completed' : 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      message: sent
        ? 'A diagnostic email was queued for delivery to the authenticated administrator.'
        : 'The diagnostic email was not queued for delivery.',
    };
  }

  public async queueAction(input: {
    queueName: string;
    action: 'retry_failed' | 'clear_completed' | 'pause' | 'resume';
    confirm: boolean;
    adminId: string;
    ipAddress?: string | null | undefined;
  }): Promise<DiagnosticActionResult> {
    const startedAt = new Date();
    if (!input.confirm) throw new Error('Explicit confirmation is required');
    if (!Object.values(QUEUE_NAMES).includes(input.queueName as never)) {
      throw new Error('Unknown queue');
    }
    const redisUrl = resolveRedisUrl((key) => this.config.get<string>(key));
    if (!redisUrl) throw new Error('Redis is not configured');
    const queue = new Queue(input.queueName, { connection: { url: redisUrl } });
    let affected = 0;
    try {
      if (input.action === 'retry_failed') {
        const failedBefore = await queue.getFailedCount();
        await queue.retryJobs({ count: 100, state: 'failed' });
        const failedAfter = await queue.getFailedCount();
        affected = Math.max(0, failedBefore - failedAfter);
      } else if (input.action === 'clear_completed') {
        affected = (await queue.clean(0, 1_000, 'completed')).length;
      } else if (input.action === 'pause') {
        await queue.pause();
      } else {
        await queue.resume();
      }
      await this.audit.record({
        adminId: input.adminId,
        action: `health_queue_${input.action}`,
        target: input.queueName,
        details: { affected },
        ipAddress: input.ipAddress,
      });
      return {
        action: input.action,
        status: 'completed',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        message: `${input.action.replaceAll('_', ' ')} completed for ${input.queueName}; ${affected.toString()} jobs affected.`,
      };
    } finally {
      await queue.close();
    }
  }

  public async exportReport(input: {
    adminId: string;
    ipAddress?: string | null | undefined;
  }): Promise<Record<string, unknown>> {
    const [dashboard, incidents, errors, alerts] = await Promise.all([
      this.orchestrator.dashboard(false),
      this.incidents.list(1, 100),
      this.errors.list({ page: 1, limit: 100 }),
      this.alerts.list(),
    ]);
    await this.audit.record({
      adminId: input.adminId,
      action: 'health_diagnostic_report_exported',
      target: 'system',
      ipAddress: input.ipAddress,
    });
    return {
      generatedAt: new Date().toISOString(),
      dashboard,
      incidents: incidents.data,
      errors: errors.data,
      alertRules: alerts.map((rule) => ({
        ...rule,
        recipients: rule.recipients.map(() => '[configured]'),
      })),
      sanitised: true,
    };
  }
}
