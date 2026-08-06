import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { maskPhone } from '../../common/utils/mask.util';
import { evaluatePhoneRecipient } from '../../common/utils/staging-messaging-guard.util';
import { MessageChannel } from '../entities';
import type { RenderedMessage } from '../templates/template.types';
import type { ChannelSendResult, ChannelTarget, ParentChannel } from './parent-channel.interface';

/** Meta Graph API version. Bump deliberately — payload shapes change. */
const GRAPH_VERSION = 'v21.0';

/**
 * Meta error codes we must not retry. Retrying these burns the queue and, for
 * 131_047/131_026, can get the WhatsApp Business number rate-limited.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const PERMANENT_ERROR_CODES = new Set([
  131_026, // Message undeliverable — recipient is not a WhatsApp user.
  131_047, // Re-engagement required (outside the 24h window, no template).
  131_051, // Unsupported message type.
  132_000, // Template param count mismatch.
  132_001, // Template does not exist / not approved.
  132_005, // Template hydrated text too long.
  133_010, // Phone number not registered.
]);

/** Recipient simply isn't on WhatsApp — demote the guardian and fall back to SMS. */
const NOT_ON_WHATSAPP_CODES = new Set([131_026, 133_010]);

interface MetaSendResponse {
  messages?: { id: string }[];
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_data?: { details?: string } };
}

/**
 * WhatsApp via the Meta Cloud API.
 *
 * Business-initiated messages must use a pre-approved template: Meta only
 * permits free-form text inside a 24-hour window opened by the *customer*
 * messaging us first, which a parent who never replies will never open. So this
 * adapter refuses to send when the renderer produced no `whatsappTemplate`,
 * rather than emitting a body that Meta would reject with 131_047.
 */
@Injectable()
export class WhatsAppMetaChannel implements ParentChannel {
  public readonly channel = MessageChannel.WHATSAPP;

  private readonly logger = new Logger(WhatsAppMetaChannel.name);
  private readonly phoneNumberId: string;
  private readonly accessToken: string;

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.phoneNumberId = configService.get<string>('META_WHATSAPP_PHONE_NUMBER_ID') ?? '';
    this.accessToken = configService.get<string>('META_WHATSAPP_ACCESS_TOKEN') ?? '';

    if (!this.isConfigured()) {
      this.logger.warn('Meta WhatsApp not configured — WhatsApp delivery disabled');
    }
  }

  public isConfigured(): boolean {
    return this.phoneNumberId !== '' && this.accessToken !== '';
  }

  public supports(target: ChannelTarget): boolean {
    return this.isConfigured() && target.whatsappCapable;
  }

  public async send(target: ChannelTarget, message: RenderedMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { accepted: false, error: 'WhatsApp not configured', permanent: true };
    }

    const template = message.whatsappTemplate;
    if (template === undefined) {
      return {
        accepted: false,
        error: `Template ${message.templateKey} has no approved WhatsApp template`,
        permanent: true,
      };
    }

    // Staging-only enforcement (inert on production) — this is the one place
    // that ever calls the real Graph API, so it is checked here rather than
    // in the registry or the worker. Sandboxed sends are ACCEPTED (marked
    // delivered) rather than failed, so callers don't fall back to SMS for a
    // send that was deliberately never attempted.
    const decision = evaluatePhoneRecipient(
      (key) => this.configService.get<string>(key),
      target.phoneE164,
    );
    if (decision.blocked) {
      this.logger.log(`WhatsApp sandboxed, not sent (${decision.reason ?? 'staging'}).`);
      return { accepted: true };
    }

    // Meta wants the number without the leading '+'.
    const to = target.phoneE164.replace(/^\+/, '');

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components:
          template.bodyParameters.length > 0
            ? [
                {
                  type: 'body',
                  parameters: template.bodyParameters.map((text) => ({ type: 'text', text })),
                },
              ]
            : [],
      },
    };

    try {
      const response = await firstValueFrom(
        this.http.post<MetaSendResponse>(
          `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 15_000,
          },
        ),
      );

      const providerMessageId = response.data.messages?.[0]?.id;
      this.logger.log(
        `WhatsApp accepted for ${maskPhone(target.phoneE164) ?? '***'} (${message.templateKey})`,
      );

      // Accepted ≠ delivered. `delivered_at` is only ever set by the webhook.
      return providerMessageId === undefined
        ? { accepted: true }
        : { accepted: true, providerMessageId };
    } catch (error) {
      return this.toResult(error, target);
    }
  }

  private toResult(error: unknown, target: ChannelTarget): ChannelSendResult {
    const axiosError = error as AxiosError<MetaErrorBody>;
    const metaError = axiosError.response?.data?.error;
    const code = metaError?.code;
    const status = axiosError.response?.status;

    const reason =
      metaError?.error_data?.details ??
      metaError?.message ??
      (error instanceof Error ? error.message : 'Unknown WhatsApp error');

    // 4xx other than 429 is a request we should not repeat verbatim.
    const permanent =
      (code !== undefined && PERMANENT_ERROR_CODES.has(code)) ||
      (status !== undefined && status >= 400 && status < 500 && status !== 429);

    const result: ChannelSendResult = { accepted: false, error: reason };
    if (permanent) result.permanent = true;
    if (code !== undefined && NOT_ON_WHATSAPP_CODES.has(code)) result.recipientNotOnChannel = true;

    this.logger.warn(
      `WhatsApp failed for ${maskPhone(target.phoneE164) ?? '***'} ` +
        `(code=${String(code ?? status ?? 'n/a')}, permanent=${String(permanent)}): ${reason}`,
    );
    return result;
  }
}
