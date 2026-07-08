import { BullModule } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';

import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';

import { IdempotencyModule } from '../idempotency/idempotency.module';
import { QUEUE_CONFIGS, QUEUE_NAMES } from './queues.constants';

/**
 * Queues Module
 *
 * Configures BullMQ job queues with Redis and Bull Board admin UI.
 *
 * Features:
 * - 4 job queues: webhook fulfillment, email, image processing, file cleanup
 * - Bull Board UI at /admin/queues for monitoring
 * - Automatic retry with exponential backoff
 * - Priority-based job processing
 * - Dead letter queues for failed jobs
 *
 * Access Bull Board: http://localhost:3000/admin/queues
 *
 * TODO: Add processors and producers as we build modules:
 * - PaymentProcessor for EasyKash webhooks
 * - NotificationProcessor for Firebase SMS
 * - EmailProcessor for email notifications
 */
@Module({
  imports: [
    /**
     * Import IdempotencyModule for webhook deduplication
     */
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),

    /**
     * Register all BullMQ queues
     * Each queue gets its own configuration from QUEUE_CONFIGS
     */
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.WEBHOOK_FULFILLMENT,
      adapter: BullMQAdapter,
    }),

    BullModule.forRoot({
      connection: QUEUE_CONFIGS[QUEUE_NAMES.WEBHOOK_FULFILLMENT].connection,
    }),

    /**
     * Bull Board Admin UI
     * Provides visual dashboard for monitoring queues
     */
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.EMAIL,
      adapter: BullMQAdapter,
    }),

    /**
     * Register queues with Bull Board for monitoring
     */
    BullModule.registerQueue(
      {
        name: QUEUE_NAMES.WEBHOOK_FULFILLMENT,
        ...QUEUE_CONFIGS[QUEUE_NAMES.WEBHOOK_FULFILLMENT],
      },
      {
        name: QUEUE_NAMES.EMAIL,
        ...QUEUE_CONFIGS[QUEUE_NAMES.EMAIL],
      },
      {
        name: QUEUE_NAMES.IMAGE_PROCESSING,
        ...QUEUE_CONFIGS[QUEUE_NAMES.IMAGE_PROCESSING],
      },
      {
        name: QUEUE_NAMES.FILE_CLEANUP,
        ...QUEUE_CONFIGS[QUEUE_NAMES.FILE_CLEANUP],
      },
      {
        name: QUEUE_NAMES.CODE_GENERATION,
        ...QUEUE_CONFIGS[QUEUE_NAMES.CODE_GENERATION],
      },
      {
        name: QUEUE_NAMES.CODE_EXPORT,
        ...QUEUE_CONFIGS[QUEUE_NAMES.CODE_EXPORT],
      },
      {
        name: QUEUE_NAMES.EXAM_AUTO_SUBMIT,
        ...QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AUTO_SUBMIT],
      },
      {
        name: QUEUE_NAMES.EXAM_AI_GRADING,
        ...QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AI_GRADING],
      },
      {
        name: QUEUE_NAMES.EXAM_OMR,
        ...QUEUE_CONFIGS[QUEUE_NAMES.EXAM_OMR],
      },
      {
        name: QUEUE_NAMES.EXAM_ANALYTICS,
        ...QUEUE_CONFIGS[QUEUE_NAMES.EXAM_ANALYTICS],
      },
      {
        name: QUEUE_NAMES.GAMIFICATION,
        ...QUEUE_CONFIGS[QUEUE_NAMES.GAMIFICATION],
      },
    ),
    IdempotencyModule,
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.IMAGE_PROCESSING,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.FILE_CLEANUP,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.CODE_GENERATION,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.CODE_EXPORT,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.EXAM_AUTO_SUBMIT,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.EXAM_AI_GRADING,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.EXAM_OMR,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.EXAM_ANALYTICS,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.GAMIFICATION,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    // TODO: Add processors as we build modules:
    // PaymentWebhookProcessor,
    // NotificationProcessor,
    // EmailProcessor,
  ],
  exports: [BullModule],
})
export class QueuesModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - BullMQ queues registered
  }
}
