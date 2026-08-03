import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { DateRangeQueryDto } from '../reports/dto/date-range-query.dto';
import { AnalyticsService } from './analytics.service';
import {
  AdminDashboardDto,
  ExamAnalyticsDto,
  LessonAnalyticsDto,
  StudentDashboardDto,
  TeacherDashboardDto,
} from './dto';

@ApiTags('Analytics')
@Controller('analytics')
@UseGuards(HybridAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Admin Dashboard - Platform-wide statistics
   */
  @Get('admin/dashboard')
  @Roles('admin')
  @ApiOperation({
    summary: 'Get admin dashboard statistics',
    description:
      'Returns platform-wide statistics for the admin dashboard. Admin only.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Admin dashboard statistics',
    type: AdminDashboardDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Admin role required',
  })
  public async getAdminDashboard(@GetUser() user: JwtPayload): Promise<{ data: AdminDashboardDto }> {
    const stats = await this.analyticsService.getAdminDashboard(user.tenantId);
    return { data: stats };
  }

  /**
   * Teacher Dashboard - Teacher-specific statistics
   */
  @Get('teacher/dashboard')
  @Roles('teacher')
  @ApiOperation({
    summary: 'Get teacher dashboard statistics',
    description:
      'Returns statistics for the authenticated teacher dashboard. Teacher only.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher dashboard statistics',
    type: TeacherDashboardDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Teacher role required',
  })
  public async getTeacherDashboard(
    @GetUser() user: JwtPayload,
    @Query() query: DateRangeQueryDto,
  ): Promise<{ data: TeacherDashboardDto }> {
    const stats = await this.analyticsService.getTeacherDashboard(
      user.userId,
      user.tenantId,
      query.from ? new Date(query.from) : undefined,
      query.to ? new Date(query.to) : undefined,
    );
    return { data: stats };
  }

  /**
   * Student Dashboard - Student-specific statistics
   */
  @Get('student/dashboard')
  @Roles('student')
  @ApiOperation({
    summary: 'Get student dashboard statistics',
    description:
      'Returns statistics for the authenticated student dashboard. Student only.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student dashboard statistics',
    type: StudentDashboardDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Student role required',
  })
  public async getStudentDashboard(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: StudentDashboardDto }> {
    const stats = await this.analyticsService.getStudentDashboard(user.userId, user.tenantId);
    return { data: stats };
  }

  // ==================== PER-RESOURCE ANALYTICS ====================

  /**
   * Get analytics for a specific lesson
   * Returns purchase counts, views, completion rate, revenue, and ratings
   */
  @Get('lessons/:lessonId')
  @Roles('admin', 'teacher')
  @ApiOperation({
    summary: 'Get lesson analytics',
    description:
      'Returns detailed analytics for a specific lesson including purchases, views, completion rate, revenue, and ratings. Cached for 5 minutes.',
  })
  @ApiParam({
    name: 'lessonId',
    description: 'Lesson UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson analytics',
    type: LessonAnalyticsDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async getLessonAnalytics(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<{ data: LessonAnalyticsDto }> {
    const analytics = await this.analyticsService.getLessonAnalytics(user, lessonId);
    return { data: analytics };
  }

  /**
   * Get analytics for a specific exam
   * Returns submissions, scores, pass rate, and per-question analysis
   */
  @Get('exams/:examId')
  @Roles('admin', 'teacher')
  @ApiOperation({
    summary: 'Get exam analytics',
    description:
      'Returns detailed analytics for a specific exam including submissions, scores, pass rate, and per-question analysis. Cached for 5 minutes.',
  })
  @ApiParam({
    name: 'examId',
    description: 'Exam UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Exam analytics',
    type: ExamAnalyticsDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found',
  })
  public async getExamAnalytics(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
  ): Promise<{ data: ExamAnalyticsDto }> {
    const analytics = await this.analyticsService.getExamAnalytics(user, examId);
    return { data: analytics };
  }
}
