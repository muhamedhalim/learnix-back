import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PaymentsService } from '../services/payments.service';
import { PaymentFilterDto } from '../dto/payment-filter.dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

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
    description:
      'Returns paginated list of all payments with optional filters.',
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
  async getAllPayments(@Query() filter: PaymentFilterDto) {
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
  async getRevenue(
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
  ) {
    const from = fromDate ? new Date(fromDate) : undefined;
    const to = toDate ? new Date(toDate) : undefined;

    const stats = await this.paymentsService.getRevenueStatistics(from, to);
    return {
      data: stats,
    };
  }

  @Get('lesson-purchases')
  @ApiOperation({
    summary: 'Get all lesson purchases',
    description: 'Returns paginated list of all lesson purchases.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson purchases retrieved successfully',
  })
  async getAllLessonPurchases(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return await this.paymentsService.getAllLessonPurchases(
      page || 1,
      limit || 20,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get payment by ID',
    description: 'Returns payment details by ID.',
  })
  @ApiParam({ name: 'id', description: 'Payment ID', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Payment retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Payment not found',
  })
  async getPaymentById(@Param('id', ParseUUIDPipe) id: string) {
    const payment = await this.paymentsService.getPaymentById(id);
    if (!payment) {
      return { error: 'Payment not found' };
    }
    return { data: payment };
  }

  @Post('lesson-purchases/:id/extend')
  @ApiOperation({
    summary: 'Extend lesson access',
    description: 'Extends lesson access by 1 day for a specific purchase.',
  })
  @ApiParam({ name: 'id', description: 'Lesson purchase ID', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Access extended successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Purchase not found',
  })
  async extendLessonAccess(@Param('id', ParseUUIDPipe) purchaseId: string) {
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
