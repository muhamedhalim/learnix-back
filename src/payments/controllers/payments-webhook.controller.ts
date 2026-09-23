import { Body, Controller, Inject, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InvalidatesCache } from '../../common/cache/cache-invalidation.decorator';
import { SkipCsrf } from '../../common/guards/csrf.guard';
import { biBody } from '../../i18n/error-translator.util';
import { performanceMetrics } from '../../observability/performance-metrics.registry';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type ProviderWebhookRequest,
} from '../providers/payment-gateway.interface';
import { GatewayWebhookResponse, GatewayWebhookService } from '../services/gateway-webhook.service';

/**
 * Family union verified and approved in `gates/W1-C2-webhook.md` (T025): the
 * union of every family whose compute reads a table this webhook writes,
 * across every settlement type (lesson/lesson-session/package/book,
 * succeeded/refunded/failed, single-order/cart/marketplace). Never narrow to
 * a per-settlement-type subset — one route serves every settlement type.
 * `public_catalog` was added when T037(a) introduced it (`gates/W1-C2-webhook.md`
 * §7 anticipated this exact addition: the family reads `package_purchases`,
 * which a lesson/lesson-session/package finalization or a full refund's
 * `revokeAccess` writes, changing the cached preview's `students_count`).
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

@ApiTags('Payments - Webhook')
@Controller('payments/webhook')
@SkipThrottle()
export class PaymentsWebhookController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly webhooks: GatewayWebhookService,
  ) {}

  @Post()
  @SkipCsrf()
  @InvalidatesCache(PAYMENTS_WEBHOOK_INVALIDATES_CACHE)
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

  @Post('callback')
  @SkipCsrf()
  @InvalidatesCache(PAYMENTS_WEBHOOK_INVALIDATES_CACHE)
  @ApiOperation({ summary: 'Alternative payment gateway callback URL' })
  public async handleCallback(
    @Body() payload: unknown,
    @Query('hmac') signature?: string,
  ): Promise<GatewayWebhookResponse> {
    return this.handleWebhook(payload, signature);
  }
}
