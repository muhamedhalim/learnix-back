import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { biBody } from '../../i18n/error-translator.util';
import { performanceMetrics } from '../../observability/performance-metrics.registry';
import { EasyKashWebhookDto } from '../dto/easykash-webhook.dto';
import { EasyKashService } from '../services/easykash.service';
import { GatewayWebhookResponse, GatewayWebhookService } from '../services/gateway-webhook.service';

@ApiTags('Payments - Webhook')
@Controller('payments/webhook')
@SkipThrottle()
export class PaymentsWebhookController {
  constructor(
    private readonly easyKash: EasyKashService,
    private readonly webhooks: GatewayWebhookService,
  ) {}

  @Post()
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature' })
  public async handleEasyKashWebhook(
    @Body() dto: EasyKashWebhookDto,
  ): Promise<GatewayWebhookResponse> {
    if (!this.easyKash.verifyHmac(dto, dto.signatureHash)) {
      performanceMetrics.recordFailure('webhook');
      throw new UnauthorizedException(biBody('Invalid HMAC signature', 'توقيع HMAC غير صالح'));
    }
    return this.webhooks.processEasyKash(dto);
  }

  @Post('callback')
  @ApiOperation({ summary: 'Alternative EasyKash callback URL' })
  public async handleEasyKashCallback(
    @Body() dto: EasyKashWebhookDto,
  ): Promise<GatewayWebhookResponse> {
    return this.handleEasyKashWebhook(dto);
  }
}
