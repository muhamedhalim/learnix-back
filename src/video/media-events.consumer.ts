import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import type { Message } from '@aws-sdk/client-sqs';

import { startSqsPoller } from '../common/utils/sqs-poller';
import { runsBackgroundWork } from '../config/process-role';
import { AwsVideoService, outcomeFromEvent } from './aws-video.service';
import { VideoConfig } from './video.config';

/**
 * Applies MediaConvert "Job State Change" events (EventBridge -> SQS) to their assets. Runs only
 * in processes that do background work (worker / all). A message is deleted only after it was
 * applied (or recognised as irrelevant); the 5-minute reconcile cron in AwsVideoService covers
 * events that never arrive.
 */
@Injectable()
export class MediaEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaEventsConsumer.name);
  private poller: { stop: () => Promise<void> } | null = null;

  constructor(
    private readonly cfg: VideoConfig,
    private readonly video: AwsVideoService,
  ) {}

  public onModuleInit(): void {
    if (!runsBackgroundWork() || this.cfg.eventsQueueUrl === '') return;
    this.poller = startSqsPoller({
      region: this.cfg.region,
      queueUrl: this.cfg.eventsQueueUrl,
      handle: (message) => this.handle(message),
      logger: this.logger,
    });
    this.logger.log('Listening for MediaConvert job events');
  }

  public async onModuleDestroy(): Promise<void> {
    await this.poller?.stop();
  }

  /** Returns true when the message can be deleted. */
  public async handle(message: Message): Promise<boolean> {
    let envelope: { detail?: Parameters<typeof outcomeFromEvent>[0] };
    try {
      envelope = JSON.parse(message.Body ?? '{}') as typeof envelope;
    } catch {
      this.logger.warn('Dropping unparseable media event');
      return true;
    }
    const outcome = envelope.detail ? outcomeFromEvent(envelope.detail) : null;
    if (outcome === null) return true;
    try {
      await this.video.applyOutcome(outcome);
      return true;
    } catch (err) {
      this.logger.error(`Applying job ${outcome.jobId} failed: ${(err as Error).message}`);
      return false;
    }
  }
}
