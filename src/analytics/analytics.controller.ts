import { Controller, HttpStatus } from '@nestjs/common';
import {
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { GetUser } from '../common/decorators/get-user.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { AnalyticsService } from './analytics.service';
import {
  AdminDashboardDto,
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
}
