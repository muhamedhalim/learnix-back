import { Injectable } from '@nestjs/common';

import { MessageChannel } from '../entities';
import { SmsSenderService } from '../services/sms-sender.service';
import type { RenderedMessage } from '../templates/template.types';
import type { ChannelSendResult, ChannelTarget, ParentChannel } from './parent-channel.interface';

/**
 * SMS fallback (AWS End User Messaging SMS; Twilio only as the rollback provider).
 *
 * The send call only proves the provider ACCEPTED the message, so the row stops at SENT here. With
 * AWS, carrier delivery receipts arrive later through the configuration set's event destination and
 * `SmsEventsConsumer` promotes the row to DELIVERED or FAILED by `provider_message_id`. Twilio has no
 * callback configured, so its messages stay at SENT. SMS has no read receipt either way.
 */
@Injectable()
export class SmsChannel implements ParentChannel {
  public readonly channel = MessageChannel.SMS;

  constructor(private readonly sms: SmsSenderService) {}

  public isConfigured(): boolean {
    return this.sms.isConfigured();
  }

  /** Any phone number can receive SMS — this is the universal fallback. */
  public supports(_target: ChannelTarget): boolean {
    return this.isConfigured();
  }

  public async send(
    target: ChannelTarget,
    message: RenderedMessage,
  ): Promise<ChannelSendResult> {
    const result = await this.sms.sendSms(target.phoneE164, message.body);

    if (result.success) {
      return result.messageId === undefined
        ? { accepted: true }
        : { accepted: true, providerMessageId: result.messageId };
    }

    return { accepted: false, error: result.error ?? 'SMS delivery failed' };
  }
}
