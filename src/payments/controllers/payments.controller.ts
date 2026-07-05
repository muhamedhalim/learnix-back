import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { BillingDataDto } from '../dto/billing-data.dto';
import { PaymentFilterDto } from '../dto/payment-filter.dto';
import { PurchaseLessonDto } from '../dto/purchase-lesson.dto';
import { PurchasePackageDto } from '../dto/purchase-package.dto';
import { PaymentsService } from '../services/payments.service';

@ApiTags('Payments - Student')
@Controller('payments')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('purchase/lesson')
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  public async purchaseLesson(
    @Body() dto: PurchaseLessonDto,
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: unknown }> {
    const result = await this.paymentsService.purchaseLesson(dto, user.userId);
    return {
      message: 'Payment initiated successfully',
      data: result,
    };
  }

  @Post('purchase/package')
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  public async purchasePackage(
    @Body() dto: PurchasePackageDto,
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: unknown }> {
    const result = await this.paymentsService.purchasePackage(dto, user.userId);
    return {
      message: 'Payment initiated successfully',
      data: result,
    };
  }

  @Post('reopen/:id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async reopenLesson(
    @Param('id', ParseUUIDPipe) lessonId: string,
    @Body() billingData: BillingDataDto,
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: unknown }> {
    const result = await this.paymentsService.reopenLesson(lessonId, user.userId, billingData);
    return {
      message: 'Reopen payment initiated at 50% price',
      data: result,
    };
  }

  @Get('my-purchases')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase history retrieved successfully',
  })
  public async getMyPurchases(
    @Query() filter: PaymentFilterDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    const result = await this.paymentsService.getMyPurchases(user.userId, filter);
    return result;
  }

  @Get('my-lessons')
  @ApiOperation({
    summary: 'Get my active lesson access',
    description: 'Returns list of lessons the student currently has access to (not expired).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Active lessons retrieved successfully',
  })
  public async getMyLessons(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: unknown; total: number }> {
    const lessons = await this.paymentsService.getMyLessons(user.userId);
    return {
      data: lessons,
      total: lessons.length,
    };
  }

  @Get('my-packages')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchased packages retrieved successfully',
  })
  public async getMyPackages(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: unknown; total: number }> {
    const packages = await this.paymentsService.getMyPackages(user.userId);
    return {
      data: packages,
      total: packages.length,
    };
  }

  @Get('access/:id')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Access status retrieved successfully',
  })
  public async checkLessonAccess(
    @Param('id', ParseUUIDPipe) lessonId: string,
    @GetUser() user: JwtPayload,
  ): Promise<{ data: unknown }> {
    const access = await this.paymentsService.checkLessonAccess(user.userId, lessonId);
    return {
      data: access,
    };
  }
}
