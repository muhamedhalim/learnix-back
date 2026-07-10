import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';

import * as crypto from 'node:crypto';
import type { Request } from 'express';

import { SkipCsrf } from '../../common/guards/csrf.guard';
import { ParentMessageStatus } from '../entities';
import { ParentMessageService, type ProviderStatus } from '../services/parent-message.service';

interface MetaStatusEntry {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  errors?: { title?: string; message?: string }[];
}

interface MetaWebhookBody {
  object?: string;
  entry?: {
    changes?: {
      value?: {
        statuses?: MetaStatusEntry[];
      };
    }[];
  }[];
}

/**
 * Meta Cloud API delivery callbacks.
 *
 * This is the *only* thing allowed to promote a message past SENT. Without it,
 * "delivered" would mean nothing more than "the provider took our HTTP request",
 * which is precisely the bug the old SMS code shipped.
 *
 * Security: Meta signs every POST with an HMAC-SHA256 of the raw body under the
 * app secret. We verify it in constant time before touching the database — this
 * endpoint is unauthenticated and internet-facing, so an unsigned body is the
 * only thing standing between an attacker and forged delivery receipts.
 */
@ApiExcludeController()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);
  private readonly appSecret: string;
  private readonly verifyToken: string;

  constructor(
    private readonly messages: ParentMessageService,
    configService: ConfigService,
  ) {
    this.appSecret = configService.get<string>('META_WHATSAPP_APP_SECRET') ?? '';
    this.verifyToken = configService.get<string>('META_WHATSAPP_VERIFY_TOKEN') ?? '';
  }

  /** Meta's one-time subscription handshake. */
  @Get()
  public verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (this.verifyToken === '') throw new ForbiddenException();

    const expected = Buffer.from(this.verifyToken);
    const actual = Buffer.from(token ?? '');
    const matches =
      expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

    if (mode !== 'subscribe' || !matches) throw new ForbiddenException();
    return challenge;
  }

  // Meta cannot present a CSRF token; the HMAC signature is the auth mechanism.
  @SkipCsrf()
  @Post()
  @HttpCode(HttpStatus.OK)
  public async receive(
    @Req() request: Request,
    @Body() body: MetaWebhookBody,
  ): Promise<{ received: true }> {
    this.assertSignature(request);

    const statuses =
      body.entry?.flatMap(
        (entry) => entry.changes?.flatMap((change) => change.value?.statuses ?? []) ?? [],
      ) ?? [];

    for (const status of statuses) {
      await this.apply(status);
    }

    // Always 200: a non-2xx makes Meta retry the whole batch, and these
    // callbacks are at-least-once already. `applyProviderStatus` is monotonic
    // and idempotent, so replays are harmless.
    return { received: true };
  }

  private async apply(entry: MetaStatusEntry): Promise<void> {
    const mapped: Record<MetaStatusEntry['status'], ProviderStatus> = {
      sent: ParentMessageStatus.SENT,
      delivered: ParentMessageStatus.DELIVERED,
      read: ParentMessageStatus.READ,
      failed: ParentMessageStatus.FAILED,
    };

    const status = mapped[entry.status];
    // Meta may add statuses we do not model (e.g. `deleted`).
    if (status === undefined) return;

    const seconds = Number.parseInt(entry.timestamp, 10);
    const at = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
    const error = entry.errors?.[0]?.message ?? entry.errors?.[0]?.title;

    const updated = await this.messages.applyProviderStatus(entry.id, status, at, error);
    if (!updated) {
      this.logger.debug(`Ignored ${entry.status} for unknown/stale message ${entry.id}`);
    }
  }

  /**
   * Verify `X-Hub-Signature-256` against the raw request body.
   *
   * Requires `rawBody: true` on the Nest application (see `main.ts`). If the raw
   * body is unavailable we fail closed rather than silently trusting the payload.
   */
  private assertSignature(request: Request): void {
    if (this.appSecret === '') {
      throw new ForbiddenException('WhatsApp webhook not configured');
    }

    const header = request.header('x-hub-signature-256');
    if (header === undefined || !header.startsWith('sha256=')) {
      throw new BadRequestException('Missing signature');
    }

    const raw = (request as Request & { rawBody?: Buffer }).rawBody;
    if (raw === undefined) {
      this.logger.error('rawBody unavailable — cannot verify webhook signature');
      throw new ForbiddenException('Signature verification unavailable');
    }

    const expected = crypto.createHmac('sha256', this.appSecret).update(raw).digest();
    const provided = Buffer.from(header.slice('sha256='.length), 'hex');

    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      throw new ForbiddenException('Invalid signature');
    }
  }
}
