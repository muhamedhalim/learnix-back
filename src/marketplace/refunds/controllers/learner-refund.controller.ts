import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { THROTTLE } from '../../../common/constants';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { RefundRequestThrottlerGuard } from '../../common/guards/per-account-throttler.guard';
import { idempotencyKeyMissing } from '../../common/errors';
import { RefundEligibilityService, RefundEligibilityVerdict } from '../eligibility.service';
import { MarketplaceRefundRequest } from '../entities';
import { RequestRefundDto } from '../dto/request-refund.dto';
import { RefundRequestService } from '../refund-request.service';

/**
 * Contracts §4 refund block. Deliberately mounted at the SAME
 * `marketplace/me/orders` base path as `LearnerOrdersController`
 * (`../../commerce/controllers/learner-orders.controller.ts`) rather than
 * duplicating that resource — Nest allows multiple controllers to share a
 * path prefix as long as the routes themselves don't collide, and none do
 * here (`:id/refund-eligibility`, `:id/refund`). Kept in its own file/module
 * since refund logic belongs to the refunds domain, not commerce.
 */
@ApiTags('Marketplace / Refunds')
@Controller('marketplace/me/orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LearnerRefundController {
  constructor(
    private readonly eligibility: RefundEligibilityService,
    private readonly refundRequests: RefundRequestService,
  ) {}

  @Get(':id/refund-eligibility')
  @ApiOperation({ summary: 'Days remaining and current consumption for this order (FR-183)' })
  public async checkEligibility(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) orderId: string,
  ): Promise<RefundEligibilityVerdict> {
    return this.eligibility.checkEligibility(user.userId, orderId);
  }

  @Post(':id/refund')
  @UseGuards(RefundRequestThrottlerGuard)
  @Throttle({ default: THROTTLE.STRICT })
  @ApiOperation({ summary: 'Request a refund; Idempotency-Key required (FR-177, FR-199)' })
  public async requestRefund(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: RequestRefundDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MarketplaceRefundRequest> {
    if (!idempotencyKey) {
      throw idempotencyKeyMissing();
    }
    return this.refundRequests.requestRefund(user.userId, orderId, dto.reason, idempotencyKey);
  }
}
