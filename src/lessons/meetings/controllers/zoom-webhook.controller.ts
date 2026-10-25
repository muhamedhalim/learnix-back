import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import { SkipCsrf } from '../../../common/guards/csrf.guard';
import { biBody } from '../../../i18n/error-translator.util';
import { MeetingProvider } from '../../entities/meeting-provider.enum';
import { MeetingAccountsService } from '../meeting-accounts.service';

/** Zoom signs `v0:{timestamp}:{rawBody}`; reject anything older than this to stop replays. */
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

interface ZoomWebhookBody {
  event?: string;
  payload?: {
    plainToken?: string;
    user_id?: string;
  };
}

/**
 * Zoom Marketplace webhooks: the endpoint-validation handshake and
 * `app_deauthorized` (a published Marketplace app must handle it). On
 * deauthorization the teacher's connection is marked `revoked` right away
 * instead of failing the next Generate. Unauthenticated and internet-facing,
 * so every request must carry a valid HMAC over the raw body, and the endpoint
 * fails closed when the secret token is not configured.
 */
@ApiExcludeController()
@Controller('webhooks/zoom')
export class ZoomWebhookController {
  private readonly logger = new Logger(ZoomWebhookController.name);
  private readonly secretToken: string;

  public constructor(
    private readonly accounts: MeetingAccountsService,
    configService: ConfigService,
  ) {
    this.secretToken = configService.get<string>('ZOOM_WEBHOOK_SECRET_TOKEN') ?? '';
  }

  @Post()
  @SkipCsrf()
  @HttpCode(HttpStatus.OK)
  public async handle(
    @Req() request: Request,
    @Body() body: ZoomWebhookBody,
  ): Promise<Record<string, unknown>> {
    this.assertSignature(request);

    if (body.event === 'endpoint.url_validation') {
      const plainToken = body.payload?.plainToken;
      if (typeof plainToken !== 'string' || plainToken === '') {
        throw new BadRequestException(biBody('Invalid webhook payload', 'محتوى webhook غير صالح'));
      }
      // Safe only because the signature was verified above: otherwise this would
      // be an HMAC oracle for forging signatures.
      return { plainToken, encryptedToken: this.hmacHex(plainToken) };
    }

    if (body.event === 'app_deauthorized') {
      const userId = body.payload?.user_id;
      if (typeof userId === 'string' && userId !== '') {
        const revoked = await this.accounts.markRevokedByProviderAccount(MeetingProvider.ZOOM, userId);
        this.logger.log(`Zoom app_deauthorized: revoked ${String(revoked)} connection(s)`);
      }
      return {};
    }

    this.logger.debug(`Ignored Zoom webhook event ${String(body.event)}`);
    return {};
  }

  private hmacHex(message: string): string {
    return createHmac('sha256', this.secretToken).update(message).digest('hex');
  }

  private assertSignature(request: Request): void {
    if (this.secretToken === '') {
      throw new ForbiddenException(
        biBody('Zoom webhook not configured', 'لم يتم تهيئة webhook الخاص بزووم'),
      );
    }
    const signature = request.header('x-zm-signature');
    const timestamp = request.header('x-zm-request-timestamp');
    if (!signature || !timestamp) {
      throw new BadRequestException(biBody('Missing signature', 'التوقيع مفقود'));
    }
    const raw = (request as Request & { rawBody?: Buffer }).rawBody;
    if (raw === undefined) {
      this.logger.error('rawBody unavailable — cannot verify Zoom webhook signature');
      throw new ForbiddenException(
        biBody('Signature verification unavailable', 'التحقق من التوقيع غير متاح'),
      );
    }
    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_TIMESTAMP_SKEW_SECONDS) {
      throw new ForbiddenException(biBody('Stale webhook request', 'طلب webhook قديم'));
    }
    const expected = Buffer.from(`v0=${this.hmacHex(`v0:${timestamp}:${raw.toString('utf8')}`)}`);
    const provided = Buffer.from(signature);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ForbiddenException(biBody('Invalid signature', 'توقيع غير صالح'));
    }
  }
}
