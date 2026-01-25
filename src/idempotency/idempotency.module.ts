import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { IdempotencyService } from './idempotency.service';

/**
 * Module providing idempotency services for preventing duplicate request processing.
 *
 * @remarks
 * **Dependencies:**
 * - Redis: For distributed idempotency key storage
 * - ConfigService: For Redis connection configuration
 *
 * **Redis Configuration:**
 * Reads `REDIS_URL` from environment variables.
 * Format: `redis://[:password@]host[:port][/database]`
 *
 * **Connection Management:**
 * - Connects on module initialization (OnModuleInit)
 * - Disconnects on module shutdown (OnModuleDestroy)
 * - Graceful degradation if Redis unavailable (logs error, continues without idempotency)
 *
 * **Exports:**
 * - IdempotencyService: For use in PaymentsModule, WebhookProcessor, etc.
 *
 * @example
 * ```typescript
 * // In PaymentsModule
 * @Module({
 *   imports: [IdempotencyModule],
 *   providers: [PaymentsService],
 * })
 * export class PaymentsModule {}
 *
 * // In PaymentsService
 * constructor(private idempotencyService: IdempotencyService) {}
 * ```
 */
@Module({
  imports: [ConfigModule],
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Idempotency services ready
  }
}
