import { Injectable } from '@nestjs/common';

import { MessageChannel } from '../entities';
import { SmsSenderService } from '../services/sms-sender.service';
import type { RenderedMessage } from '../templates/template.types';
import type { ChannelSendResult, ChannelTarget, ParentChannel } from './parent-channel.interface';

/**
 * SMS fallback, wrapping the pre-existing Twilio sender.
 *
 * SMS has no read receipt and (as configured) no delivery webhook, so a message
 * sent here can only ever reach SENT — never DELIVERED. That is a real property
 * of the transport, and the status column now reflects it honestly instead of
 * claiming delivery on provider acceptance.
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
