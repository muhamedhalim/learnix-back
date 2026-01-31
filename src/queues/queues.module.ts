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
 * - PaymentProcessor for Paymob webhooks
 * - NotificationProcessor for Firebase SMS
 * - EmailProcessor for email notifications
 */
@Module({
  imports: [
    /**
     * Import IdempotencyModule for webhook deduplication
     */
    IdempotencyModule,

    /**
     * Register all BullMQ queues
     * Each queue gets its own configuration from QUEUE_CONFIGS
     */
    BullModule.forRoot({
      connection: QUEUE_CONFIGS[QUEUE_NAMES.WEBHOOK_FULFILLMENT].connection,
    }),

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
    ),

    /**
     * Bull Board Admin UI
     * Provides visual dashboard for monitoring queues
     */
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),

    /**
     * Register queues with Bull Board for monitoring
     */
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.WEBHOOK_FULFILLMENT,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.EMAIL,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.IMAGE_PROCESSING,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.FILE_CLEANUP,
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
