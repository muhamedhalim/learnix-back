import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Message } from '@aws-sdk/client-sqs';

import { maskPhone } from '../../common/utils/mask.util';
import { startSqsPoller } from '../../common/utils/sqs-poller';
import { runsBackgroundWork } from '../../config/process-role';

export interface SmsDeliveryEvent {
  eventType: string;
  messageId: string | null;
  status: string | null;
  destination: string | null;
  /** True for terminal states where the message did not reach the handset. */
  failed: boolean;
}

const FAILED_STATES = new Set([
  'TEXT_BLOCKED',
  'TEXT_CARRIER_UNREACHABLE',
  'TEXT_INVALID',
  'TEXT_UNREACHABLE',
  'TEXT_TTL_EXPIRED',
  'TEXT_UNKNOWN',
]);

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
  return {
    eventType,
    messageId: str(event['messageId']),
    status: str(event['messageStatus']),
    destination: str(event['destinationPhoneNumber']),
    failed: FAILED_STATES.has(eventType),
  };
}

/**
 * Reads SMS delivery feedback in worker processes and makes it observable (structured log, warn on
 * failure so a log metric filter can alarm). It does not change application state: the guardian
 * flows already treat an SMS as best-effort after WhatsApp.
 */
@Injectable()
export class SmsEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsEventsConsumer.name);
  private poller: { stop: () => Promise<void> } | null = null;

  constructor(private readonly config: ConfigService) {}

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

  public handle(message: Message): Promise<boolean> {
    const event = parseSmsEvent(message.Body ?? '');
    if (event !== null) {
      const line = JSON.stringify({
        event: 'sms_delivery',
        type: event.eventType,
        status: event.status,
        messageId: event.messageId,
        destination: maskPhone(event.destination) ?? 'unknown',
      });
      if (event.failed) this.logger.warn(line);
      else this.logger.log(line);
    }
    return Promise.resolve(true);
  }
}
