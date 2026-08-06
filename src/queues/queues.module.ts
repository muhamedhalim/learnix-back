import { BullModule } from '@nestjs/bullmq';
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';

import { resolveRedisUrl } from '../common/utils/redis-connection.util';
import { bullMqPrefix } from '../common/utils/redis-namespace.util';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { bullBoardAuthMiddleware } from './bull-board-auth.middleware';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from './queues.constants';
import { registerQueues } from './register-queues.util';

const logger = new Logger('QueuesModule');

/** Bull Board only has something to show for queues that are actually
 * Redis-backed — skip its per-queue panels entirely when queues are
 * disabled, rather than pointing them at a `NoopQueue` they can't introspect. */
const queuesEnabled = areQueuesEnabled();

function boardPanel(name: string) {
  return BullBoardModule.forFeature({ name, adapter: BullMQAdapter });
}

/**
 * Queues Module
 *
 * Configures BullMQ job queues with Redis and Bull Board admin UI.
 *
 * Production: `BullModule.forRootAsync` below fails fast if Redis isn't
 * configured, exactly as the previous synchronous `getRedisConnection()`
 * check did — see its factory for the exact error message.
 *
 * Development: when Redis isn't configured, `registerQueues` (used here and
 * in every other module that registers a queue — `attendance-codes`,
 * `exams`, `gamification`, `notifications`) swaps in a `NoopQueue` under the
 * same DI token instead of a real one, so the app boots and every
 * `@InjectQueue` consumer keeps resolving without a real Redis connection
 * ever being attempted.
 *
 * Access Bull Board: http://localhost:3000/admin/queues
 */
@Module({
  imports: [
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
      // Require HTTP Basic Auth before the dashboard router runs. Fails closed
      // when BULL_BOARD_USER / BULL_BOARD_PASSWORD are unset (no anonymous access).
      middleware: bullBoardAuthMiddleware(),
    }),

    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = resolveRedisUrl((key) => configService.get<string>(key));
        const isProduction = configService.get<string>('NODE_ENV') === 'production';

        if (redisUrl === undefined) {
          if (isProduction) {
            throw new Error(
              'CRITICAL: REDIS_URL is required. BullMQ cannot start without a Redis connection.',
            );
          }
          logger.warn(
            'REDIS_URL not set — BullMQ queues are disabled for this development session ' +
              '(background jobs will no-op; see NoopQueue). Set REDIS_URL to exercise real queues.',
          );
          // BullMQ's own `QueueOptions` type requires `connection` to be
          // present, but this value is never actually dereferenced: every
          // `registerQueues(...)` call (here and in every other module that
          // registers a queue) resolves `NoopQueue` providers instead of real
          // ones whenever `redisUrl` is undefined, so no queue or worker ever
          // opens a connection with it.
          return { connection: { host: '127.0.0.1', port: 6379 } };
        }

        // `undefined` on a resolved-production environment (no APP_ENV=staging
        // and no explicit REDIS_NAMESPACE) — BullMQ then keeps its own default
        // `'bull'` prefix, byte-identical to before this option was passed at
        // all. Staging gets a purpose-built prefix so its queues cannot be
        // read or written by a production worker sharing the same Redis host.
        const prefix = bullMqPrefix((key) => configService.get<string>(key));

        return { connection: { url: redisUrl }, ...(prefix !== undefined ? { prefix } : {}) };
      },
    }),

    /**
     * Register all BullMQ queues.
     * Each queue gets its own job-option tuning from QUEUE_CONFIGS; the
     * connection is inherited from `BullModule.forRootAsync` above.
     */
    registerQueues(
      { name: QUEUE_NAMES.EMAIL, config: QUEUE_CONFIGS[QUEUE_NAMES.EMAIL] },
      { name: QUEUE_NAMES.IMAGE_PROCESSING, config: QUEUE_CONFIGS[QUEUE_NAMES.IMAGE_PROCESSING] },
      { name: QUEUE_NAMES.FILE_CLEANUP, config: QUEUE_CONFIGS[QUEUE_NAMES.FILE_CLEANUP] },
      { name: QUEUE_NAMES.CODE_GENERATION, config: QUEUE_CONFIGS[QUEUE_NAMES.CODE_GENERATION] },
      { name: QUEUE_NAMES.CODE_EXPORT, config: QUEUE_CONFIGS[QUEUE_NAMES.CODE_EXPORT] },
      { name: QUEUE_NAMES.EXAM_AUTO_SUBMIT, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AUTO_SUBMIT] },
      { name: QUEUE_NAMES.EXAM_AI_GRADING, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AI_GRADING] },
      { name: QUEUE_NAMES.EXAM_OMR, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_OMR] },
      { name: QUEUE_NAMES.EXAM_ANALYTICS, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_ANALYTICS] },
      { name: QUEUE_NAMES.GAMIFICATION, config: QUEUE_CONFIGS[QUEUE_NAMES.GAMIFICATION] },
    ),
    IdempotencyModule,

    /**
     * Bull Board Admin UI panels — one per queue, monitoring dashboard.
     * Skipped entirely when queues are disabled (see `queuesEnabled` above).
     */
    ...(queuesEnabled
      ? [
          boardPanel(QUEUE_NAMES.EMAIL),
          boardPanel(QUEUE_NAMES.IMAGE_PROCESSING),
          boardPanel(QUEUE_NAMES.FILE_CLEANUP),
          boardPanel(QUEUE_NAMES.CODE_GENERATION),
          boardPanel(QUEUE_NAMES.CODE_EXPORT),
          boardPanel(QUEUE_NAMES.EXAM_AUTO_SUBMIT),
          boardPanel(QUEUE_NAMES.EXAM_AI_GRADING),
          boardPanel(QUEUE_NAMES.EXAM_OMR),
          boardPanel(QUEUE_NAMES.EXAM_ANALYTICS),
          boardPanel(QUEUE_NAMES.GAMIFICATION),
        ]
      : []),
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
