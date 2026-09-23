import { Body, Controller, Inject, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { SkipCsrf } from '../../../common/guards/csrf.guard';
import { biBody } from '../../../i18n/error-translator.util';
import { performanceMetrics } from '../../../observability/performance-metrics.registry';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type ProviderWebhookRequest,
} from '../../../payments/providers/payment-gateway.interface';
import { GatewayWebhookResponse, GatewayWebhookService } from '../../../payments/services/gateway-webhook.service';

/**
 * Same union as `PaymentsWebhookController` (T025/T033, `gates/W1-C2-webhook.md`):
 * this route ends in the identical `GatewayWebhookService.process()`.
 */
const PAYMENTS_WEBHOOK_INVALIDATES_CACHE = [
  'admin_dashboard',
  'teacher_dashboard',
  'teacher_report',
  'platform_report',
  'lesson_analytics',
  'student_dashboard',
  'student_profile',
  'marketplace_catalog',
  'public_catalog',
] as const;

/**
 * T099. Functionally identical to `PaymentsWebhookController` — same
 * gateway HMAC verification, same `GatewayWebhookService.process()` (timing-
 * safe signature check + `GatewayWebhookEvent` replay guard +
 * `GatewayFinancialStateMachineService.apply()`'s transaction). This exists
 * as its own route because Paymob's webhook destination is fixed per
 * merchant/integration, not settable per transaction (confirmed against
 * `ProviderCheckoutInput`/`PaymobGateway` — there is no per-call callback
 * URL); a deployment that configures a dedicated marketplace Paymob
 * integration points it here, and one that doesn't can safely leave this
 * route unused — `GatewayFinancialStateMachineService`'s own
 * `item_type === 'marketplace_course'` branch already makes
 * `/payments/webhook` handle a marketplace capture correctly either way,
 * so nothing is lost if this route never receives real traffic.
 */
@ApiTags('Marketplace - Webhook')
@Controller('marketplace/webhooks/payment')
@SkipThrottle()
export class MarketplaceWebhookController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly webhooks: GatewayWebhookService,
  ) {}

  @Post()
  // T033 (gates/W1-C2-webhook.md): the same union as PaymentsWebhookController, because
  // `GatewayWebhookService.process()` resolves the payment by merchant reference and runs the academic finalization
  // (lesson/package/book entitlements, orders, refunds) for any payment delivered here, so a marketplace-only family
  // set would leave student/teacher/admin families stale. A marketplace item's enrollment itself is written later by
  // the outbox-driven `MarketplaceSettlementListener` (a non-HTTP writer), not by this request — accepted TTL drift,
  // rule-7 exception recorded in `gates/W1-C2-webhook.md` §5 and `implementation/T032-write-sets.md` §6 (T032).
  @SkipCsrf()
  @InvalidatesCache(PAYMENTS_WEBHOOK_INVALIDATES_CACHE)
  @ApiOperation({ summary: 'Paymob webhook callback for a marketplace course purchase' })
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature' })
  public async handleWebhook(
    @Body() payload: unknown,
    @Query('hmac') signature?: string,
  ): Promise<GatewayWebhookResponse> {
    const request: ProviderWebhookRequest = {
      payload,
      ...(signature === undefined ? {} : { signature }),
    };
    if (!this.gateway.verifyWebhook(request)) {
      performanceMetrics.recordFailure('webhook');
      throw new UnauthorizedException(biBody('Invalid HMAC signature', 'توقيع HMAC غير صالح'));
    }
    return this.webhooks.process(this.gateway.parseWebhook(request));
  }
}
