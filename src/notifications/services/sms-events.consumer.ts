import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Message } from '@aws-sdk/client-sqs';

import { maskPhone } from '../../common/utils/mask.util';
import { startSqsPoller } from '../../common/utils/sqs-poller';
import { runsBackgroundWork } from '../../config/process-role';
import { ParentMessageStatus } from '../entities';
import { ParentMessageService, type ProviderStatus } from './parent-message.service';

export interface SmsDeliveryEvent {
  eventType: string;
  messageId: string | null;
  status: string | null;
  destination: string | null;
  /** True for terminal states where the message did not reach the handset. */
  failed: boolean;
  /** Event time (provider clock), when present. */
  at: Date | null;
}

const FAILED_STATES = new Set([
  'TEXT_BLOCKED',
  'TEXT_CARRIER_BLOCKED',
  'TEXT_CARRIER_UNREACHABLE',
  'TEXT_INVALID',
  'TEXT_INVALID_MESSAGE',
  'TEXT_PROTECT_BLOCKED',
  'TEXT_SPAM',
  'TEXT_UNREACHABLE',
  'TEXT_TTL_EXPIRED',
  'TEXT_UNKNOWN',
]);

/**
 * Status a delivery event moves a guardian message to, or null when the event carries no new
 * information (queued / accepted by AWS — the row is already SENT when the send call returned).
 */
export function toProviderStatus(event: SmsDeliveryEvent): ProviderStatus | null {
  if (event.failed) return ParentMessageStatus.FAILED;
  if (event.eventType === 'TEXT_DELIVERED') return ParentMessageStatus.DELIVERED;
  return null;
}

/** Parses an AWS End User Messaging SMS event (configuration set -> SNS -> SQS; raw or SNS-wrapped). */
export function parseSmsEvent(body: string): SmsDeliveryEvent | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body) as Record<string, unknown>;
    if (typeof event['Message'] === 'string') event = JSON.parse(event['Message']) as Record<string, unknown>;
  } catch {
    return null;
  }
  const eventType = event['eventType'];
  if (typeof eventType !== 'string') return null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const timestamp = Number(event['eventTimestamp']);
  return {
    eventType,
    messageId: str(event['messageId']),
    status: str(event['messageStatus']),
    destination: str(event['destinationPhoneNumber']),
    failed: FAILED_STATES.has(eventType),
    at: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : null,
  };
}

/**
 * Reads SMS delivery feedback in worker processes (configuration set -> SNS -> SQS):
 *  - every event is logged as `sms_delivery` (destination masked); failures at `warn`, which the
 *    CloudWatch metric filter `SmsDeliveryFailures` counts and alarms on;
 *  - delivery and failure events promote the matching guardian message (`parent_messages`, keyed by
 *    the provider message id stored when the SMS was sent) from SENT to DELIVERED or FAILED, through
 *    the same monotonic path the WhatsApp status webhook uses. OTP texts have no message row and
 *    are only logged.
 */
@Injectable()
export class SmsEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsEventsConsumer.name);
  private poller: { stop: () => Promise<void> } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly messages: ParentMessageService,
  ) {}

  public onModuleInit(): void {
    const queueUrl = this.config.get<string>('SMS_EVENTS_QUEUE_URL')?.trim() ?? '';
    if (!runsBackgroundWork() || queueUrl === '') return;
    this.poller = startSqsPoller({
      region: this.config.get<string>('AWS_REGION') || 'eu-central-1',
      queueUrl,
      handle: (message) => this.handle(message),
      logger: this.logger,
    });
    this.logger.log('Listening for SMS delivery events');
  }

  public async onModuleDestroy(): Promise<void> {
    await this.poller?.stop();
  }

  /**
   * Returns false (message stays on the queue and is retried, then lands on the DLQ) only when the
   * database update itself throws; unparseable or unrelated events are acknowledged.
   */
  public async handle(message: Message): Promise<boolean> {
    const event = parseSmsEvent(message.Body ?? '');
    if (event === null) return true;

    const status = toProviderStatus(event);
    let updated = false;
    if (status !== null && event.messageId !== null) {
      try {
        updated = await this.messages.applyProviderStatus(
          event.messageId,
          status,
          event.at ?? new Date(),
          event.failed ? `SMS ${event.eventType}` : undefined,
        );
      } catch (err) {
        this.logger.error(`Recording SMS status for ${event.messageId} failed: ${(err as Error).message}`);
        return false;
      }
    }

    const line = JSON.stringify({
      event: 'sms_delivery',
      type: event.eventType,
      status: event.status,
      messageId: event.messageId,
      destination: maskPhone(event.destination) ?? 'unknown',
      recorded: updated,
    });
    if (event.failed) this.logger.warn(line);
    else this.logger.log(line);
    return true;
  }
}
