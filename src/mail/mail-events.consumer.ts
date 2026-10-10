import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Message } from '@aws-sdk/client-sqs';

import { maskEmail } from '../common/utils/mask.util';
import { startSqsPoller } from '../common/utils/sqs-poller';
import { runsBackgroundWork } from '../config/process-role';
import { performanceMetrics } from '../observability/performance-metrics.registry';

export interface MailFeedbackEvent {
  kind: 'bounce' | 'complaint';
  /** `Permanent` bounces and complaints are suppressed by SES itself (account-level list). */
  permanent: boolean;
  recipients: string[];
}

/**
 * Parses an SES feedback notification (SES configuration set -> SNS -> SQS). Handles both the raw
 * SNS envelope and an unwrapped event, and the `eventType` (event publishing) and `notificationType`
 * (identity notification) spellings.
 */
export function parseSesFeedback(body: string): MailFeedbackEvent | null {
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  let event = outer;
  if (typeof outer['Message'] === 'string') {
    try {
      event = JSON.parse(outer['Message']) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const type = String(event['eventType'] ?? event['notificationType'] ?? '').toLowerCase();
  if (type === 'bounce') {
    const bounce = (event['bounce'] ?? {}) as {
      bounceType?: string;
      bouncedRecipients?: Array<{ emailAddress?: string }>;
    };
    return {
      kind: 'bounce',
      permanent: bounce.bounceType === 'Permanent',
      recipients: (bounce.bouncedRecipients ?? []).flatMap((r) => (r.emailAddress ? [r.emailAddress] : [])),
    };
  }
  if (type === 'complaint') {
    const complaint = (event['complaint'] ?? {}) as { complainedRecipients?: Array<{ emailAddress?: string }> };
    return {
      kind: 'complaint',
      permanent: true,
      recipients: (complaint.complainedRecipients ?? []).flatMap((r) => (r.emailAddress ? [r.emailAddress] : [])),
    };
  }
  return null;
}

/**
 * Consumes SES bounce/complaint feedback in worker processes. SES's account-level suppression
 * list stops further sends to permanently bounced and complaining addresses on its own; this
 * consumer makes the feedback visible (structured log + failure metric) so deliverability
 * problems show up in dashboards and alarms instead of silently eroding the sender reputation.
 */
@Injectable()
export class MailEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailEventsConsumer.name);
  private poller: { stop: () => Promise<void> } | null = null;

  constructor(private readonly config: ConfigService) {}

  public onModuleInit(): void {
    const queueUrl = this.config.get<string>('MAIL_EVENTS_QUEUE_URL')?.trim() ?? '';
    if (!runsBackgroundWork() || queueUrl === '') return;
    this.poller = startSqsPoller({
      region: this.config.get<string>('SES_REGION') || this.config.get<string>('AWS_REGION') || 'eu-central-1',
      queueUrl,
      handle: (message) => this.handle(message),
      logger: this.logger,
    });
    this.logger.log('Listening for SES bounce/complaint feedback');
  }

  public async onModuleDestroy(): Promise<void> {
    await this.poller?.stop();
  }

  public handle(message: Message): Promise<boolean> {
    const event = parseSesFeedback(message.Body ?? '');
    if (event !== null) {
      if (event.permanent) performanceMetrics.recordFailure('email');
      this.logger.warn(
        JSON.stringify({
          event: `ses_${event.kind}`,
          permanent: event.permanent,
          recipients: event.recipients.map((r) => maskEmail(r) ?? 'unknown'),
        }),
      );
    }
    return Promise.resolve(true);
  }
}
