import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpStatus,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { PaymentsService } from '../services/payments.service';
import { PurchaseLessonDto } from '../dto/purchase-lesson.dto';
import { PurchasePackageDto } from '../dto/purchase-package.dto';
import { PaymentFilterDto } from '../dto/payment-filter.dto';
import { BillingDataDto } from '../dto/billing-data.dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

@ApiTags('Payments - Student')
@Controller('payments')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('purchase-lesson')
  @ApiOperation({
    summary: 'Purchase a lesson',
    description:
      'Initiates a payment to purchase a lesson. Returns payment key and iframe URL for Paymob.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Payment initiated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Already have access to this lesson',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  async purchaseLesson(
    @Body() dto: PurchaseLessonDto,
    @GetUser() user: JwtPayload,
  ) {
    const result = await this.paymentsService.purchaseLesson(dto, user.userId);
    return {
      message: 'Payment initiated successfully',
      data: result,
    };
  }

  @Post('purchase-package')
  @ApiOperation({
    summary: 'Purchase a lesson package',
    description:
      'Initiates a payment to purchase a lesson package. Returns payment key and iframe URL for Paymob.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Payment initiated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  async purchasePackage(
    @Body() dto: PurchasePackageDto,
    @GetUser() user: JwtPayload,
  ) {
    const result = await this.paymentsService.purchasePackage(dto, user.userId);
    return {
      message: 'Payment initiated successfully',
      data: result,
    };
  }

  @Post('lesson/:id/reopen')
  @ApiOperation({
    summary: 'Reopen an expired lesson',
    description:
      'Reopens an expired lesson at 50% of the current price. Must have previously purchased the lesson.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID', type: Number })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Reopen payment initiated successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Lesson not previously purchased or access still active',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  async reopenLesson(
    @Param('id', ParseIntPipe) lessonId: number,
    @Body() billingData: BillingDataDto,
    @GetUser() user: JwtPayload,
  ) {
    const result = await this.paymentsService.reopenLesson(
      lessonId,
      user.userId,
      billingData,
    );
    return {
      message: 'Reopen payment initiated at 50% price',
      data: result,
    };
  }

  @Get('my-purchases')
  @ApiOperation({
    summary: 'Get my purchase history',
    description:
      'Returns paginated list of payment history for the authenticated student.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase history retrieved successfully',
  })
  async getMyPurchases(
    @Query() filter: PaymentFilterDto,
    @GetUser() user: JwtPayload,
  ) {
    const result = await this.paymentsService.getMyPurchases(
      user.userId,
      filter,
    );
    return result;
  }

  @Get('my-lessons')
  @ApiOperation({
    summary: 'Get my active lesson access',
    description:
      'Returns list of lessons the student currently has access to (not expired).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Active lessons retrieved successfully',
  })
  async getMyLessons(@GetUser() user: JwtPayload) {
    const lessons = await this.paymentsService.getMyLessons(user.userId);
    return {
      data: lessons,
      total: lessons.length,
    };
  }

  @Get('my-packages')
  @ApiOperation({
    summary: 'Get my purchased packages',
    description: 'Returns list of packages the student has purchased.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchased packages retrieved successfully',
  })
  async getMyPackages(@GetUser() user: JwtPayload) {
    const packages = await this.paymentsService.getMyPackages(user.userId);
    return {
      data: packages,
      total: packages.length,
    };
  }

  @Get('lesson/:id/access')
  @ApiOperation({
    summary: 'Check lesson access',
    description: 'Check if the student has active access to a specific lesson.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Access status retrieved successfully',
  })
  async checkLessonAccess(
    @Param('id', ParseIntPipe) lessonId: number,
    @GetUser() user: JwtPayload,
  ) {
    const access = await this.paymentsService.checkLessonAccess(
      user.userId,
      lessonId,
    );
    return {
      data: access,
    };
  }
}
