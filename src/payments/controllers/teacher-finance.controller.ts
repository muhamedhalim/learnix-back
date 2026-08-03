import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { OrderFilterDto, RefundFilterDto, RequestSettlementDto, SettlementFilterDto } from '../dto';
import { OrdersService } from '../services/orders.service';
import { RefundsService } from '../services/refunds.service';
import { SettlementsService } from '../services/settlements.service';

@ApiTags('Teacher - Finance')
@Controller('teacher/finance')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherFinanceController {
  constructor(
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly settlements: SettlementsService,
  ) {}

  @Get('wallet')
  public async wallet(@GetUser() user: JwtPayload) {
    return { data: await this.settlements.getTeacherWallet(user.userId) };
  }

  @Get('orders')
  public async ordersList(@Query() filter: OrderFilterDto, @GetUser() user: JwtPayload) {
    const scopedFilter = { ...filter };
    delete scopedFilter.teacher_id;
    return this.orders.findTeacherOrders({ ...scopedFilter, teacher_id: user.userId });
  }

  @Get('orders/:id')
  public async orderDetails(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: JwtPayload) {
    return { data: await this.orders.findTeacherOrder(id, user.userId) };
  }

  @Get('settlements')
  public async settlementList(@Query() filter: SettlementFilterDto, @GetUser() user: JwtPayload) {
    const scopedFilter = { ...filter };
    delete scopedFilter.teacher_id;
    return this.settlements.list(scopedFilter, user.userId);
  }

  @Get('settlements/:id')
  public async settlementDetails(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.settlements.details(id, user.userId) };
  }

  @Post('settlements/request')
  public async requestSettlement(@Body() dto: RequestSettlementDto, @GetUser() user: JwtPayload) {
    return {
      data: await this.settlements.create(
        {
          teacher_id: user.userId,
          currency: dto.currency,
          ...(dto.idempotency_key === undefined ? {} : { idempotency_key: dto.idempotency_key }),
          ...(dto.fiscal_period === undefined ? {} : { fiscal_period: dto.fiscal_period }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
          // The actual transfer method is entered by the separate staff payout step.
          payment_method: 'teacher_requested',
        },
        user.userId,
      ),
    };
  }

  @Get('refunds')
  public async refundList(@Query() filter: RefundFilterDto, @GetUser() user: JwtPayload) {
    const scopedFilter = { ...filter };
    delete scopedFilter.teacher_id;
    return this.refunds.list({ ...scopedFilter, teacher_id: user.userId });
  }
}
