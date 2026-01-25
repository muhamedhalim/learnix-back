import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { PaymentsService } from '../services/payments.service';

@ApiTags('Teacher Revenue')
@Controller('teacher/revenue')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Get teacher revenue summary
   */
  @Get()
  @ApiOperation({
    summary: 'Get revenue summary',
    description:
      'Returns detailed revenue breakdown for the authenticated teacher.',
  })
  @ApiQuery({
    name: 'from_date',
    required: false,
    type: String,
    description: 'Filter from date (ISO format)',
  })
  @ApiQuery({
    name: 'to_date',
    required: false,
    type: String,
    description: 'Filter to date (ISO format)',
  })
  @ApiQuery({
    name: 'group_by',
    required: false,
    enum: ['day', 'week', 'month'],
    description: 'Group revenue by period (default: month)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Revenue summary retrieved',
    schema: {
      example: {
        total_revenue: 15000,
        revenue_by_period: [
          { period: '2025-01', revenue: 5000, sales: 10 },
          { period: '2025-02', revenue: 10000, sales: 20 },
        ],
        top_lessons: [
          { lesson_id: 1, lesson_title: 'Math 101', revenue: 3000, sales: 6 },
        ],
        date_range: { from: '2025-01-01', to: '2025-02-28' },
      },
    },
  })
  public async getRevenue(
    @GetUser() user: JwtPayload,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
    @Query('group_by') groupBy: 'day' | 'week' | 'month' = 'month',
  ): Promise<unknown> {
    return this.paymentsService.getTeacherRevenue(
      user.userId,
      fromDate,
      toDate,
      groupBy,
    );
  }

  /**
   * Get revenue by lesson
   */
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Revenue by lesson retrieved',
    schema: {
      example: {
        lessons: [
          {
            lesson_id: 1,
            lesson_title: 'Math 101',
            purchase_count: 10,
            total_revenue: 1500,
            avg_price: 150,
          },
        ],
      },
    },
  })
  public async getRevenueByLesson(@GetUser() user: JwtPayload): Promise<unknown> {
    return this.paymentsService.getTeacherRevenueByLesson(user.userId);
  }

  /**
   * Get revenue by package
   */
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Revenue by package retrieved',
  })
  public async getRevenueByPackage(@GetUser() user: JwtPayload): Promise<unknown> {
    return this.paymentsService.getTeacherRevenueByPackage(user.userId);
  }
}
