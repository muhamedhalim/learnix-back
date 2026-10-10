import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Between, Repository } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { ActivityLog, AuditLog } from './entities';
import { AuditEvent } from './events/audit.events';

export interface ActivityLogFilter {
  from?: string | undefined;
  to?: string | undefined;
  action?: string | undefined;
  resourceType?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface AuditLogFilter {
  from?: string | undefined;
  to?: string | undefined;
  action?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

@Injectable()
export class ActivityLogsService {
  constructor(
    @InjectRepository(ActivityLog)
    private readonly activityLogRepository: Repository<ActivityLog>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * Persist an administrative audit record for security-sensitive operations
   * that must not rely on asynchronous event delivery alone.
   */
  public async recordAuditEvent(event: AuditEvent): Promise<void> {
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
  }

  /**
   * The most recent audit record for one `(action, targetType, targetId)`
   * triple, or `null` if none exists. Lets a caller derive a "since the
   * last time an admin did X" watermark (e.g. the marketplace's FR-016
   * resubmission-attempt reset) without duplicating `audit_logs` access
   * outside this service.
   */
  public async getLatestAuditRecord(
    action: string,
    targetType: string,
    targetId: string,
  ): Promise<AuditLog | null> {
    return this.auditLogRepository.findOne({
      where: { action, target_type: targetType, target_id: targetId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Get activity logs for a specific user (student or teacher)
   */
  public async getUserActivityLogs(
    userId: string,
    filter: ActivityLogFilter,
  ): Promise<{ data: ActivityLog[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = Math.min(filter.limit ?? 50, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.activityLogRepository
      .createQueryBuilder('log')
      .where('log.user_id = :userId', { userId })
      .andWhere('log.deleted_at IS NULL');

    // Apply date range filter
    if (filter.from !== undefined && filter.from !== '') {
      queryBuilder.andWhere('log.created_at >= :from', {
        from: new Date(filter.from),
      });
    }

    if (filter.to !== undefined && filter.to !== '') {
      queryBuilder.andWhere('log.created_at <= :to', {
        to: new Date(filter.to),
      });
    }

    // Apply action filter
    if (filter.action !== undefined && filter.action !== '') {
      queryBuilder.andWhere('log.action = :action', { action: filter.action });
    }

    // Apply resource type filter
    if (filter.resourceType !== undefined && filter.resourceType !== '') {
      queryBuilder.andWhere('log.resource_type = :resourceType', {
        resourceType: filter.resourceType,
      });
    }

    // Order by most recent first
    queryBuilder.orderBy('log.created_at', 'DESC');

    // Get total count and paginated results
    const [data, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Get audit logs (admin actions)
   */
  public async getAuditLogs(
    filter: AuditLogFilter,
  ): Promise<{ data: AuditLog[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = Math.min(filter.limit ?? 50, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('log')
      .leftJoin('log.admin', 'admin')
      .addSelect(['admin.id', 'admin.name', 'admin.email']);

    // Apply date range filter
    if (filter.from !== undefined && filter.from !== '') {
      queryBuilder.andWhere('log.created_at >= :from', {
        from: new Date(filter.from),
      });
    }

    if (filter.to !== undefined && filter.to !== '') {
      queryBuilder.andWhere('log.created_at <= :to', {
        to: new Date(filter.to),
      });
    }

    // Apply action filter
    if (filter.action !== undefined && filter.action !== '') {
      queryBuilder.andWhere('log.action = :action', { action: filter.action });
    }

    // Apply target type filter
    if (filter.targetType !== undefined && filter.targetType !== '') {
      queryBuilder.andWhere('log.target_type = :targetType', {
        targetType: filter.targetType,
      });
    }

    // Apply target id filter (parameter-bound)
    if (filter.targetId !== undefined && filter.targetId !== '') {
      queryBuilder.andWhere('log.target_id = :targetId', { targetId: filter.targetId });
    }

    // Order by most recent first (id as a stable tie-breaker for paging)
    queryBuilder.orderBy('log.created_at', 'DESC').addOrderBy('log.id', 'DESC');

    // The admin join is ManyToOne, so offset/limit pages the log rows exactly.
    const [data, total] = await queryBuilder
      .offset(skip)
      .limit(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Get available action types for filtering (activity logs)
   */
  public async getActivityActionTypes(): Promise<string[]> {
    interface ActionResult {
      action: string;
    }

    const results = await this.activityLogRepository
      .createQueryBuilder('log')
      .select('DISTINCT log.action', 'action')
      .getRawMany<ActionResult>();

    return results.map((r) => r.action).sort();
  }

  /**
   * Get available action types for filtering (audit logs)
   */
  public async getAuditActionTypes(): Promise<string[]> {
    interface ActionResult {
      action: string;
    }

    const results = await this.auditLogRepository
      .createQueryBuilder('log')
      .select('DISTINCT log.action', 'action')
      .getRawMany<ActionResult>();

    return results.map((r) => r.action).sort();
  }

  /**
   * Get activity statistics for a user
   */
  public async getUserActivityStats(
    userId: string,
    days = 30,
  ): Promise<{
    totalActions: number;
    actionsByType: Record<string, number>;
    recentActivity: ActivityLog[];
  }> {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // Get total actions
    const totalActions = await this.activityLogRepository.count({
      where: {
        user_id: userId,
        created_at: Between(fromDate, new Date()),
      },
    });

    // Get actions by type
    interface ActionCountResult {
      action: string;
      count: string;
    }

    const actionsByTypeResults = await this.activityLogRepository
      .createQueryBuilder('log')
      .select('log.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .where('log.user_id = :userId', { userId })
      .andWhere('log.created_at >= :from', { from: fromDate })
      .groupBy('log.action')
      .getRawMany<ActionCountResult>();

    const actionsByType: Record<string, number> = {};
    for (const result of actionsByTypeResults) {
      actionsByType[result.action] = Number.parseInt(result.count, 10);
    }

    // Get recent activity (last 10)
    const recentActivity = await this.activityLogRepository.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      take: 10,
    });

    return {
      totalActions,
      actionsByType,
      recentActivity,
    };
  }
}
