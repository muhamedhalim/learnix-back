import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { OrderFilterDto, RefundFilterDto, SettlementFilterDto } from '../dto';
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
    return this.orders.findOrders({ ...scopedFilter, teacher_id: user.userId });
  }

  @Get('settlements')
  public async settlementList(@Query() filter: SettlementFilterDto, @GetUser() user: JwtPayload) {
    const scopedFilter = { ...filter };
    delete scopedFilter.teacher_id;
    return this.settlements.list(scopedFilter, user.userId);
  }

  @Get('refunds')
  public async refundList(@Query() filter: RefundFilterDto, @GetUser() user: JwtPayload) {
    const scopedFilter = { ...filter };
    delete scopedFilter.teacher_id;
    return this.refunds.list({ ...scopedFilter, teacher_id: user.userId });
  }
}
