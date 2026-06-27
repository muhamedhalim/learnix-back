import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ActivityLog, AuditLog } from '../entities';
import { ActivityEvent } from '../events/activity.events';
import { AuditEvent } from '../events/audit.events';

@Injectable()
export class ActivityLogListener {
  private readonly logger = new Logger(ActivityLogListener.name);

  constructor(
    @InjectRepository(ActivityLog)
    private readonly activityLogRepository: Repository<ActivityLog>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * Handle all user activity events
   * Events are prefixed with 'activity.' in the event name
   */
  @OnEvent('activity.**')
  public async handleActivityEvent(event: ActivityEvent): Promise<void> {
    try {
      const log = this.activityLogRepository.create({
        user_id: event.userId,
        action: event.action,
        resource_type: event.resourceType,
        resource_id: event.resourceId,
        details: event.details,
        ip_address: event.ipAddress,
        user_agent: event.userAgent,
      });

      await this.activityLogRepository.save(log);

      this.logger.debug(
        `Activity logged: ${event.action} by user ${event.userId}`,
      );
    } catch (error) {
      // Don't throw - we don't want activity logging to break the main flow
      this.logger.error(
        `Failed to log activity: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Handle all admin audit events
   * Events are prefixed with 'audit.' in the event name
   */
  @OnEvent('audit.**')
  public async handleAuditEvent(event: AuditEvent): Promise<void> {
    try {
      const log = this.auditLogRepository.create({
        admin_id: event.adminId,
        action: event.action,
        target_type: event.targetType,
        target_id: event.targetId,
        target_name: event.targetName,
        details: event.details,
        ip_address: event.ipAddress,
      });

      await this.auditLogRepository.save(log);

      this.logger.debug(
        `Audit logged: ${event.action} by admin ${event.adminId}`,
      );
    } catch (error) {
      // Don't throw - we don't want audit logging to break the main flow
      this.logger.error(
        `Failed to log audit: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
