import {
  Controller,
  Get,
  Query,
  HttpStatus,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { DateRangeFilterDto } from './dto';
import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Admin - Dashboard & Analytics')
@Controller('admin/dashboard')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Get comprehensive dashboard overview
   * Aggregates user, revenue, engagement, and content statistics
   */
  @Get('overview')
  @ApiOperation({
    summary: 'Get dashboard overview',
    description:
      'Returns aggregated statistics for users, revenue, engagement, and content. Cached for 15 minutes.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Dashboard overview retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        users: {
          type: 'object',
          description: 'User statistics by role and status',
        },
        revenue: {
          type: 'object',
          description: 'Revenue statistics and trends',
        },
        engagement: {
          type: 'object',
          description: 'Exam and lesson engagement metrics',
        },
        content: {
          type: 'object',
          description: 'Content creation statistics',
        },
        period: {
          type: 'object',
          description: 'Date range for the analytics',
        },
        generatedAt: {
          type: 'string',
          format: 'date-time',
          description: 'Timestamp when data was generated',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async getDashboardOverview(@Query() dateFilter: DateRangeFilterDto) {
    const dateRange = dateFilter.getDateRange();
    const overview =
      await this.analyticsService.getDashboardOverview(dateRange);
    return {
      message: 'Dashboard overview retrieved successfully',
      data: overview,
    };
  }

  /**
   * Get detailed user analytics with growth trends
   */
  @Get('users')
  @ApiOperation({
    summary: 'Get user analytics',
    description:
      'Returns detailed user statistics including registration trends, approval rates, and role distribution. Cached for 5 minutes.',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Start date (ISO 8601)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'End date (ISO 8601)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User analytics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        stats: { type: 'object', description: 'Aggregated user statistics' },
        growthTrends: {
          type: 'array',
          description: 'Daily registration trends',
        },
        approvalRate: { type: 'number', description: 'User approval rate (%)' },
        registrationsByRole: {
          type: 'array',
          description: 'Registration breakdown by role',
        },
        period: { type: 'object', description: 'Date range' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async getUserAnalytics(@Query() dateFilter: DateRangeFilterDto) {
    const dateRange = dateFilter.getDateRange();
    const analytics = await this.analyticsService.getUserAnalytics(dateRange);
    return {
      message: 'User analytics retrieved successfully',
      data: analytics,
    };
  }

  /**
   * Get detailed revenue analytics with trends and breakdowns
   */
  @Get('revenue')
  @ApiOperation({
    summary: 'Get revenue analytics',
    description:
      'Returns revenue statistics including trends, breakdown by subject, and top-performing teachers. Cached for 5 minutes.',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Start date (ISO 8601)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'End date (ISO 8601)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Revenue analytics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        stats: { type: 'object', description: 'Aggregated revenue statistics' },
        trends: { type: 'array', description: 'Daily revenue trends' },
        bySubject: {
          type: 'array',
          description: 'Revenue breakdown by subject',
        },
        topTeachers: {
          type: 'array',
          description: 'Top teachers by revenue',
        },
        period: { type: 'object', description: 'Date range' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async getRevenueAnalytics(@Query() dateFilter: DateRangeFilterDto) {
    const dateRange = dateFilter.getDateRange();
    const analytics =
      await this.analyticsService.getRevenueAnalytics(dateRange);
    return {
      message: 'Revenue analytics retrieved successfully',
      data: analytics,
    };
  }

  /**
   * Get engagement analytics for exams and lessons
   */
  @Get('engagement')
  @ApiOperation({
    summary: 'Get engagement analytics',
    description:
      'Returns exam and lesson engagement metrics including top content, pass rates, and completion trends. Cached for 5 minutes.',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Start date (ISO 8601)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'End date (ISO 8601)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Engagement analytics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        stats: {
          type: 'object',
          description: 'Aggregated engagement statistics',
        },
        topExams: { type: 'array', description: 'Top exams by attempts' },
        topLessons: { type: 'array', description: 'Top lessons by purchases' },
        examCompletionTrend: {
          type: 'array',
          description: 'Daily exam completion trends',
        },
        period: { type: 'object', description: 'Date range' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async getEngagementAnalytics(@Query() dateFilter: DateRangeFilterDto) {
    const dateRange = dateFilter.getDateRange();
    const analytics =
      await this.analyticsService.getEngagementAnalytics(dateRange);
    return {
      message: 'Engagement analytics retrieved successfully',
      data: analytics,
    };
  }

  /**
   * Get content performance analytics
   */
  @Get('content')
  @ApiOperation({
    summary: 'Get content analytics',
    description:
      'Returns content performance metrics including popular lessons, subjects, and creation trends. Cached for 5 minutes.',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Start date (ISO 8601)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'End date (ISO 8601)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Content analytics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        stats: { type: 'object', description: 'Aggregated content statistics' },
        popularLessons: {
          type: 'array',
          description: 'Most popular lessons by enrollment',
        },
        popularSubjects: {
          type: 'array',
          description: 'Most popular subjects',
        },
        contentCreationTrend: {
          type: 'array',
          description: 'Daily content creation trends',
        },
        period: { type: 'object', description: 'Date range' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async getContentAnalytics(@Query() dateFilter: DateRangeFilterDto) {
    const dateRange = dateFilter.getDateRange();
    const analytics =
      await this.analyticsService.getContentAnalytics(dateRange);
    return {
      message: 'Content analytics retrieved successfully',
      data: analytics,
    };
  }

  /**
   * Get recent platform activity feed
   */
  @Get('recent-activity')
  @ApiOperation({
    summary: 'Get recent activity',
    description:
      'Returns the most recent platform activities including registrations, payments, and exam completions. Cached for 1 minute.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of activities to return (default: 50, max: 100)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Recent activity retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        activities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              type: { type: 'string' },
              description: { type: 'string' },
              userId: { type: 'number' },
              userName: { type: 'string' },
              metadata: { type: 'object' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
        totalCount: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async getRecentActivity(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    // Cap the limit at 100 to prevent excessive data loading
    const cappedLimit = Math.min(limit, 100);
    const activity = await this.analyticsService.getRecentActivity(cappedLimit);
    return {
      message: 'Recent activity retrieved successfully',
      data: activity,
    };
  }
}
