import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { ActivityLogsService } from './activity-logs.service';
import { ActivityLogFilterDto, AuditLogFilterDto } from './dto';

@ApiTags('Activity Logs')
@Controller()
@UseGuards(HybridAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ActivityLogsController {
  constructor(private readonly activityLogsService: ActivityLogsService) {}

  /**
   * Get student's own activity log
   */
  @Get('student/activity-log')
  @UseGuards(RolesGuard)
  @Roles('student')
  @ApiOperation({
    summary: 'Get student activity log',
    description:
      "Returns the authenticated student's activity log including purchases, exam submissions, and lesson sessions.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Activity log with pagination',
  })
  public async getStudentActivityLog(
    @GetUser() user: JwtPayload,
    @Query() filter: ActivityLogFilterDto,
  ): Promise<{ data: unknown[]; meta: unknown }> {
    const result = await this.activityLogsService.getUserActivityLogs(
      user.userId,
      {
        from: filter.from,
        to: filter.to,
        action: filter.action,
        resourceType: filter.resource_type,
        page: filter.page,
        limit: filter.limit,
      },
    );
    return result;
  }

  /**
   * Get teacher's own activity log
   */
  @Get('teacher/activity-log')
  @UseGuards(RolesGuard)
  @Roles('teacher')
  @ApiOperation({
    summary: 'Get teacher activity log',
    description:
      "Returns the authenticated teacher's activity log including content creation and exam grading.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Activity log with pagination',
  })
  public async getTeacherActivityLog(
    @GetUser() user: JwtPayload,
    @Query() filter: ActivityLogFilterDto,
  ): Promise<{ data: unknown[]; meta: unknown }> {
    const result = await this.activityLogsService.getUserActivityLogs(
      user.userId,
      {
        from: filter.from,
        to: filter.to,
        action: filter.action,
        resourceType: filter.resource_type,
        page: filter.page,
        limit: filter.limit,
      },
    );
    return result;
  }

  /**
   * Get admin audit log (all admin actions)
   */
  @Get('admin/audit-log')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Get admin audit log',
    description:
      'Returns the audit log of all admin actions including user approvals, content moderation, and bulk operations.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Audit log with pagination',
  })
  public async getAdminAuditLog(
    @Query() filter: AuditLogFilterDto,
  ): Promise<{ data: unknown[]; meta: unknown }> {
    const result = await this.activityLogsService.getAuditLogs({
      from: filter.from,
      to: filter.to,
      action: filter.action,
      targetType: filter.target_type,
      page: filter.page,
      limit: filter.limit,
    });

    // Format the response to include admin info
    const formattedData = result.data.map((log) => ({
      id: log.id,
      action: log.action,
      target_type: log.target_type,
      target_id: log.target_id,
      target_name: log.target_name,
      details: log.details,
      ip_address: log.ip_address,
      created_at: log.created_at,
      admin: {
        id: log.admin.id,
        name: log.admin.name,
        email: log.admin.email,
      },
    }));

    return { data: formattedData, meta: result.meta };
  }

  /**
   * Get available action types for filtering activity logs
   */
  @Get('admin/activity-log/action-types')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Get activity log action types',
    description:
      'Returns a list of unique action types for filtering activity logs.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of action types',
  })
  public async getActivityActionTypes(): Promise<{ data: string[] }> {
    const actionTypes = await this.activityLogsService.getActivityActionTypes();
    return { data: actionTypes };
  }

  /**
   * Get available action types for filtering audit logs
   */
  @Get('admin/audit-log/action-types')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Get audit log action types',
    description:
      'Returns a list of unique action types for filtering audit logs.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of action types',
  })
  public async getAuditActionTypes(): Promise<{ data: string[] }> {
    const actionTypes = await this.activityLogsService.getAuditActionTypes();
    return { data: actionTypes };
  }

  /**
   * Get activity statistics for a specific user (admin view)
   */
  @Get('admin/users/:userId/activity-stats')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Get user activity statistics',
    description:
      'Returns activity statistics for a specific user over the last 30 days.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User activity statistics',
  })
  public async getUserActivityStats(
    @Query('userId') userId: string,
    @Query('days') days?: string,
  ): Promise<{ data: unknown }> {
    const stats = await this.activityLogsService.getUserActivityStats(
      userId,
      days === undefined ? 30 : Number.parseInt(days, 10),
    );
    return { data: stats };
  }
}
