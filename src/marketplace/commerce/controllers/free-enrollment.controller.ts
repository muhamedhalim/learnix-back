import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { THROTTLE } from '../../../common/constants';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { PerAccountThrottlerGuard } from '../../common/guards/per-account-throttler.guard';
import { EnrollFreeDto } from '../dto/enroll-free.dto';
import { MarketplaceOrder } from '../entities';
import { FreeEnrollmentService } from '../free-enrollment.service';

/**
 * Contracts §4: `POST /marketplace/checkout/enroll-free` — a sibling of
 * `LearnerCheckoutController`'s `marketplace/checkout/orders` routes, not
 * nested under them (a free enrollment is never an "order" the learner pays
 * for), so this is its own controller rather than a third method bolted
 * onto that one. FR-119 (refund refused on a zero-value order) needs no
 * code here — Phase 9's refund-request endpoint reads `order.is_zero_value`
 * itself; there is nothing "checkout"-side to refuse in advance.
 */
@ApiTags('Marketplace / Checkout')
@Controller('marketplace/checkout')
@UseGuards(JwtAuthGuard, PerAccountThrottlerGuard)
@ApiBearerAuth('JWT-auth')
export class FreeEnrollmentController {
  constructor(private readonly freeEnrollment: FreeEnrollmentService) {}

  @Post('enroll-free')
  // Writes `marketplace_orders` + `marketplace_enrollments` (`enrollment_count` in the cached catalogue) and, via
  // listeners, `notifications`. admin_dashboard/platform_report read no marketplace table today; kept per the
  // T032 plan as a conservative superset.
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard', 'platform_report'])
  @Throttle({ default: THROTTLE.DEFAULT })
  @ApiOperation({ summary: 'Zero-value enrollment, no gateway (FR-111, FR-112); rate limited per account (FR-121)' })
  public async enrollFree(@GetUser() user: JwtPayload, @Body() dto: EnrollFreeDto): Promise<MarketplaceOrder> {
    return this.freeEnrollment.enrollFree(user.userId, dto.courseId);
  }
}
