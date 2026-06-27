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
    const from =
      query.from !== undefined && query.from !== ''
        ? new Date(query.from)
        : undefined;
    const to =
      query.to !== undefined && query.to !== ''
        ? new Date(query.to)
        : undefined;

    const report = await this.reportsService.getTeacherReport(
      user.userId,
      from,
      to,
    );
    return { data: report };
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
    const from =
      query.from !== undefined && query.from !== ''
        ? new Date(query.from)
        : undefined;
    const to =
      query.to !== undefined && query.to !== ''
        ? new Date(query.to)
        : undefined;

    const report = await this.reportsService.getPlatformReport(from, to);
    return { data: report };
  }
}
