import { Injectable, Logger } from '@nestjs/common';

import { SmsChannel } from './sms.channel';
import type { ChannelTarget, ParentChannel } from './parent-channel.interface';
import { WhatsAppMetaChannel } from './whatsapp-meta.channel';

/**
 * Chooses the transport for a guardian, in preference order.
 *
 * WhatsApp first (rich, free-to-us, has delivery + read receipts), SMS as the
 * universal fallback. The worker walks this list: a *permanent* WhatsApp
 * failure (not a WhatsApp user, template rejected) falls through to SMS within
 * the same attempt, while a *transient* failure (5xx, timeout, 429) is left for
 * BullMQ to retry on the same channel rather than silently downgrading the
 * parent to SMS forever.
 *
 * Order lives here, not in the worker, so adding a provider is a registration
 * change rather than an `if` in business code.
 */
@Injectable()
export class ChannelRegistryService {
  private readonly logger = new Logger(ChannelRegistryService.name);
  private readonly ordered: ParentChannel[];

  constructor(whatsapp: WhatsAppMetaChannel, sms: SmsChannel) {
    this.ordered = [whatsapp, sms];

    const enabled = this.ordered.filter((channel) => channel.isConfigured());
    if (enabled.length === 0) {
      this.logger.error(
        'No parent notification channel is configured — guardian messages cannot be delivered',
      );
    } else {
      this.logger.log(
        `Parent channels enabled: ${enabled.map((channel) => channel.channel).join(' → ')}`,
      );
    }
  }

  /** Configured channels that can address this target, in preference order. */
  public resolve(target: ChannelTarget): ParentChannel[] {
    return this.ordered.filter((channel) => channel.isConfigured() && channel.supports(target));
  }

  public anyConfigured(): boolean {
    return this.ordered.some((channel) => channel.isConfigured());
  }
}
