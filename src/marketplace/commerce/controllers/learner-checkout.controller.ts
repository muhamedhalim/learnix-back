import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { THROTTLE } from '../../../common/constants';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import type { BillingDataDto } from '../../../payments/dto/billing-data.dto';
import { discountsNotApplicable, idempotencyKeyMissing } from '../../common/errors';
import { MarketplaceCheckoutService, type CheckoutResult } from '../checkout.service';
import { CreateMarketplaceOrderDto } from '../dto/create-order.dto';
import { MarketplaceOrder } from '../entities';
import { MarketplaceOrderService } from '../order.service';

/**
 * Contracts §4 checkout block: order creation and gateway-intent are two
 * separate calls (`POST .../orders` then `POST .../orders/:id/pay`) so a
 * learner can review the order (price, refund terms) before committing to
 * a gateway redirect. Both require `Idempotency-Key` — read here as a plain
 * header (the same pattern `bulk-operations`/`admin-notifications` already
 * use) since class-validator has no built-in way to validate a header.
 */
@ApiTags('Marketplace / Checkout')
@Controller('marketplace/checkout/orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LearnerCheckoutController {
  constructor(
    private readonly orders: MarketplaceOrderService,
    private readonly checkout: MarketplaceCheckoutService,
  ) {}

  @Post()
  @Throttle({ default: THROTTLE.PAYMENTS })
  @ApiOperation({ summary: 'Create an order for a paid course (FR-093); Idempotency-Key required' })
  public async createOrder(
    @GetUser() user: JwtPayload,
    @Body() dto: CreateMarketplaceOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MarketplaceOrder> {
    if (!idempotencyKey) {
      throw idempotencyKeyMissing();
    }
    if (dto.discountCode) {
      throw discountsNotApplicable();
    }
    return this.orders.createOrder(user.userId, dto.courseId);
  }

  @Post(':id/pay')
  @Throttle({ default: THROTTLE.PAYMENTS })
  @ApiOperation({ summary: 'Obtain a gateway payment intent for an existing order; reuses PAYMENT_GATEWAY' })
  public async pay(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() billingData: BillingDataDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CheckoutResult> {
    if (!idempotencyKey) {
      throw idempotencyKeyMissing();
    }
    return this.checkout.createCheckout(user.userId, orderId, billingData, idempotencyKey);
  }
}
