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
import { CheckoutQuoteDto, CreateOrderDto, OrderFilterDto, StartGatewayCheckoutDto } from '../dto';
import { OrdersService } from '../services/orders.service';

@ApiTags('Payments - Unified Checkout')
@Controller('payments')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('checkout/quote')
  public async quote(@Body() dto: CheckoutQuoteDto, @GetUser() user: JwtPayload) {
    return { data: await this.orders.quote(dto, user.userId) };
  }

  @Post('orders')
  public async create(@Body() dto: CreateOrderDto, @GetUser() user: JwtPayload) {
    const result = await this.orders.createOrder(dto, user.userId);
    return {
      data: {
        order: result.order,
        payment_id: result.payment.id,
      },
    };
  }

  @Post('orders/:id/gateway')
  public async startGateway(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartGatewayCheckoutDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.orders.startGatewayCheckout(id, user.userId, dto) };
  }

  @Get('orders')
  public async list(@Query() filter: OrderFilterDto, @GetUser() user: JwtPayload) {
    return this.orders.getStudentOrders(user.userId, filter);
  }

  @Get('orders/:id')
  public async detail(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: JwtPayload) {
    return { data: await this.orders.getStudentOrder(id, user.userId) };
  }
}
