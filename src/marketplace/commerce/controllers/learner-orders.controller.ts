import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { biBody } from '../../../i18n/error-translator.util';
import { OrderStatusQueryDto } from '../dto/order-status-query.dto';
import { MarketplaceOrder } from '../entities';
import { MarketplaceOrderService } from '../order.service';

/**
 * Contracts §4: `GET /marketplace/me/orders[/:id]` — order history and
 * receipt, always scoped to the caller via `learner_id` (never a role
 * check), and 404 — never 403 — for another learner's order so no order
 * even reveals whether it exists (T104).
 */
@ApiTags('Marketplace / My Orders')
@Controller('marketplace/me/orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LearnerOrdersController {
  constructor(private readonly orders: MarketplaceOrderService) {}

  @Get()
  @ApiOperation({ summary: 'Own order history, filterable by status (FR-108)' })
  public async list(@GetUser() user: JwtPayload, @Query() query: OrderStatusQueryDto): Promise<MarketplaceOrder[]> {
    return this.orders.listOwnOrders(user.userId, query.status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Own order receipt; 404 (not 403) for another learner\'s order' })
  public async get(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<MarketplaceOrder> {
    const order = await this.orders.getOwnOrder(user.userId, id);
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    return order;
  }
}
