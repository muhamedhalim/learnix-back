import { Body, Controller, Inject, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { biBody } from '../../i18n/error-translator.util';
import { performanceMetrics } from '../../observability/performance-metrics.registry';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type ProviderWebhookRequest,
} from '../providers/payment-gateway.interface';
import { GatewayWebhookResponse, GatewayWebhookService } from '../services/gateway-webhook.service';

@ApiTags('Payments - Webhook')
@Controller('payments/webhook')
@SkipThrottle()
export class PaymentsWebhookController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly webhooks: GatewayWebhookService,
  ) {}

  @Post()
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
  @ApiOperation({ summary: 'Alternative payment gateway callback URL' })
  public async handleCallback(
    @Body() payload: unknown,
    @Query('hmac') signature?: string,
  ): Promise<GatewayWebhookResponse> {
    return this.handleWebhook(payload, signature);
  }
}
