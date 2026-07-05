import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaymentFilterDto } from '../dto/payment-filter.dto';
import { PaymentsService } from '../services/payments.service';

@ApiTags('Admin - Payments')
@Controller('admin/payments')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get all payments',
    description: 'Returns paginated list of all payments with optional filters.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Payments retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  public async getAllPayments(@Query() filter: PaymentFilterDto): Promise<unknown> {
    return await this.paymentsService.getAllPayments(filter);
  }

  @Get('revenue')
  @ApiOperation({
    summary: 'Get revenue statistics',
    description: 'Returns revenue statistics with optional date range filter.',
  })
  @ApiQuery({
    name: 'from_date',
    required: false,
    description: 'Filter from date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'to_date',
    required: false,
    description: 'Filter to date (YYYY-MM-DD)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Revenue statistics retrieved successfully',
  })
  public async getRevenue(
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
  ): Promise<{ data: unknown }> {
    const from = fromDate !== undefined && fromDate !== '' ? new Date(fromDate) : undefined;
    const to = toDate !== undefined && toDate !== '' ? new Date(toDate) : undefined;

    const stats = await this.paymentsService.getRevenueStatistics(from, to);
    return {
      data: stats,
    };
  }

  @Get('lesson-purchases')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson purchases retrieved successfully',
  })
  public async getAllLessonPurchases(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<unknown> {
    return await this.paymentsService.getAllLessonPurchases(page ?? 1, limit ?? 20);
  }

  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Payment not found',
  })
  public async getPaymentById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ error?: string; data?: unknown }> {
    const payment = await this.paymentsService.getPaymentById(id);
    if (!payment) {
      return { error: 'Payment not found' };
    }
    return { data: payment };
  }

  @Post(':id/extend')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Purchase not found',
  })
  public async extendLessonAccess(
    @Param('id', ParseUUIDPipe) purchaseId: string,
  ): Promise<{ message: string; data: unknown }> {
    const purchase = await this.paymentsService.extendLessonAccess(purchaseId);
    return {
      message: 'Lesson access extended by 1 day',
      data: {
        id: purchase.id,
        lesson_id: purchase.lesson_id,
        new_expiry: purchase.access_expires_at,
        days_extended: purchase.days_extended,
      },
    };
  }
}
