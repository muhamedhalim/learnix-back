import { Body, Controller, Inject, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

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
  // Deliberately NOT `@InvalidatesCache`: `GatewayWebhookService.process()` resolves the payment by merchant reference and
  // runs the academic finalization (lesson/package/book entitlements, orders, refunds) for any payment delivered here, so a
  // marketplace-only family set would leave student/teacher/admin families stale. It stays on the global fallback until
  // T033 declares the verified union for both webhook routes. A marketplace item's enrollment itself is written later by
  // the outbox-driven `MarketplaceSettlementListener` (a non-HTTP writer), not by this request (T032).
  @SkipCsrf()
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
