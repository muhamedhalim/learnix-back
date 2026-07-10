import type { MessageChannel } from '../entities';
import type { RenderedMessage } from '../templates/template.types';

/** Outcome of one delivery attempt. */
export interface ChannelSendResult {
  /** The provider accepted the message. NOT proof of handset delivery. */
  accepted: boolean;
  /** Provider-assigned id, correlated later by the delivery webhook. */
  providerMessageId?: string;
  error?: string;
  /**
   * True when the failure is permanent for this recipient/channel (bad number,
   * not a WhatsApp user, template missing). The worker must not burn retries on
   * these — it falls back to the next channel, or marks the message dead.
   */
  permanent?: boolean;
  /** Set when the provider says this number cannot receive WhatsApp at all. */
  recipientNotOnChannel?: boolean;
}

export interface ChannelTarget {
  guardianId: string;
  phoneE164: string;
  whatsappCapable: boolean;
}

/**
 * A transport that can deliver a rendered message to a guardian.
 *
 * Implementations own *only* provider mechanics — auth, payload shape, error
 * mapping. They never decide who receives what (guardians), what it says
 * (templates), or whether to retry (the worker). Adding 360Dialog or Twilio
 * WhatsApp means adding one class and registering it; no business code changes.
 */
export interface ParentChannel {
  readonly channel: MessageChannel;
  /** False when the provider is unconfigured — the registry skips it entirely. */
  isConfigured(): boolean;
  /** Whether this transport can address this particular guardian. */
  supports(target: ChannelTarget): boolean;
  send(target: ChannelTarget, message: RenderedMessage): Promise<ChannelSendResult>;
}

/** DI token — `ParentChannel` is an interface and cannot be injected by type. */
export const PARENT_CHANNELS = Symbol('PARENT_CHANNELS');
