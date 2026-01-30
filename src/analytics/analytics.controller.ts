import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { GetUser } from '../common/decorators/get-user.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
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
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Admin Dashboard - Platform-wide statistics
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Admin role required',
  })
  public async getAdminDashboard(): Promise<{ data: AdminDashboardDto }> {
    const stats = await this.analyticsService.getAdminDashboard();
    return { data: stats };
  }

  /**
   * Teacher Dashboard - Teacher-specific statistics
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Teacher role required',
  })
  public async getTeacherDashboard(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: TeacherDashboardDto }> {
    const stats = await this.analyticsService.getTeacherDashboard(user.userId);
    return { data: stats };
  }

  /**
   * Student Dashboard - Student-specific statistics
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Student role required',
  })
  public async getStudentDashboard(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: StudentDashboardDto }> {
    const stats = await this.analyticsService.getStudentDashboard(user.userId);
    return { data: stats };
  }

  // ==================== PER-RESOURCE ANALYTICS ====================

  /**
   * Get analytics for a specific lesson
   * Returns purchase counts, views, completion rate, revenue, and ratings
   */
  @Get('lessons/:lessonId')
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
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<{ data: LessonAnalyticsDto }> {
    const analytics = await this.analyticsService.getLessonAnalytics(lessonId);
    return { data: analytics };
  }

  /**
   * Get analytics for a specific exam
   * Returns submissions, scores, pass rate, and per-question analysis
   */
  @Get('exams/:examId')
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
    @Param('examId', ParseUUIDPipe) examId: string,
  ): Promise<{ data: ExamAnalyticsDto }> {
    const analytics = await this.analyticsService.getExamAnalytics(examId);
    return { data: analytics };
  }
}
