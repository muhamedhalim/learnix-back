import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import {
  DateRangeQueryDto,
  PlatformReportDto,
  StudentProgressReportDto,
  TeacherFollowUpSummaryDto,
  TeacherReportDto,
} from './dto';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@Controller('reports')
@UseGuards(HybridAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /**
   * `new Date('2026-05-01')` parses as UTC midnight, but the service snaps the
   * range to local-midnight boundaries. East-of-UTC servers would therefore
   * rewind a date-only bound into the previous day. Build date-only values
   * directly in local time so the boundary lands on the day the caller asked for.
   */
  private static parseBound(value?: string): Date | undefined {
    if (value === undefined || value === '') return undefined;

    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      const [, year, month, day] = dateOnly;
      return new Date(Number(year), Number(month) - 1, Number(day));
    }
    return new Date(value);
  }

  /**
   * Get teacher revenue and stats summary with date range filtering
   */
  @Get('teacher/summary')
  @Roles('teacher')
  @ApiOperation({
    summary: 'Get teacher report summary',
    description:
      'Returns teacher revenue breakdown, student stats, lesson stats, and exam stats for a date range. Defaults to last 30 days.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'Start date (ISO 8601: YYYY-MM-DD)',
    example: '2025-01-01',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'End date (ISO 8601: YYYY-MM-DD)',
    example: '2025-01-31',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher report data',
    type: TeacherReportDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Teacher role required',
  })
  public async getTeacherSummary(
    @GetUser() user: JwtPayload,
    @Query() query: DateRangeQueryDto,
  ): Promise<{ data: TeacherReportDto }> {
    const report = await this.reportsService.getTeacherReport(
      user.userId,
      ReportsController.parseBound(query.from),
      ReportsController.parseBound(query.to),
    );
    return { data: report };
  }

  /**
   * Teacher follow-up figures only (guardians, notifications, at-risk students). Not range-bound:
   * the dashboard used to fetch the whole teacher report for these three numbers.
   */
  @Get('teacher/follow-up')
  @Roles('teacher')
  @ApiOperation({
    summary: 'Get teacher follow-up summary',
    description:
      'Returns guardian, parent-notification and at-risk-student counts for the authenticated teacher. The teacher is taken from the token only.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher follow-up summary',
    type: TeacherFollowUpSummaryDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Teacher role required',
  })
  public async getTeacherFollowUp(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: TeacherFollowUpSummaryDto }> {
    return { data: await this.reportsService.getTeacherFollowUpSummary(user.userId) };
  }

  /**
   * Get student overall progress and analytics
   */
  @Get('student/progress')
  @Roles('student')
  @ApiOperation({
    summary: 'Get student progress report',
    description:
      'Returns student overall progress, subject breakdown, strengths, and areas for improvement.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student progress report',
    type: StudentProgressReportDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Student role required',
  })
  public async getStudentProgress(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: StudentProgressReportDto }> {
    const report = await this.reportsService.getStudentProgressReport(
      user.userId,
    );
    return { data: report };
  }

  /**
   * Get platform-wide statistics and metrics (Admin only)
   */
  @Get('admin/platform')
  @Roles('admin')
  @ApiOperation({
    summary: 'Get platform report',
    description:
      'Returns platform-wide user stats, revenue breakdown, content stats, and engagement metrics for a date range. Admin only. Defaults to last 30 days.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'Start date (ISO 8601: YYYY-MM-DD)',
    example: '2025-01-01',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'End date (ISO 8601: YYYY-MM-DD)',
    example: '2025-01-31',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Platform report data',
    type: PlatformReportDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Admin role required',
  })
  public async getPlatformReport(
    @Query() query: DateRangeQueryDto,
  ): Promise<{ data: PlatformReportDto }> {
    const report = await this.reportsService.getPlatformReport(
      ReportsController.parseBound(query.from),
      ReportsController.parseBound(query.to),
    );
    return { data: report };
  }
}
