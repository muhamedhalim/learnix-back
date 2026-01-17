import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GetUser } from '../common/decorators/get-user.decorator';
import { JwtPayload } from '../common/interfaces/user-request.interface';
import {
  AdminDashboardDto,
  TeacherDashboardDto,
  StudentDashboardDto,
} from './dto';

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Admin Dashboard - Platform-wide statistics
   */
  @Get('admin/dashboard')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get admin dashboard statistics',
    description:
      'Returns platform-wide statistics including user counts, content counts, and revenue metrics. Cached for 5 minutes.',
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
  async getAdminDashboard(): Promise<{ data: AdminDashboardDto }> {
    const stats = await this.analyticsService.getAdminDashboard();
    return { data: stats };
  }

  /**
   * Teacher Dashboard - Teacher-specific statistics
   */
  @Get('teacher/dashboard')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('teacher')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get teacher dashboard statistics',
    description:
      'Returns teacher-specific statistics including content counts, student counts, revenue, and ratings. Cached for 5 minutes.',
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
  async getTeacherDashboard(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: TeacherDashboardDto }> {
    const stats = await this.analyticsService.getTeacherDashboard(user.userId);
    return { data: stats };
  }

  /**
   * Student Dashboard - Student-specific statistics
   */
  @Get('student/dashboard')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('student')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get student dashboard statistics',
    description:
      'Returns student-specific statistics including purchased content, exam progress, average scores, and active access. Cached for 5 minutes.',
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
  async getStudentDashboard(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: StudentDashboardDto }> {
    const stats = await this.analyticsService.getStudentDashboard(user.userId);
    return { data: stats };
  }
}
