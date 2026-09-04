import { MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';

import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { QueuesModule } from '../queues/queues.module';
import { StorageModule } from '../storage/storage.module';
import { MarketplaceAdminModule } from './admin/admin.module';
import { CatalogModule } from './catalog/catalog.module';
import { MarketplaceCommonModule } from './common/common.module';
import { NoStoreMiddleware } from './common/no-store.middleware';
import { CommerceModule } from './commerce/commerce.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { EarningsModule } from './earnings/earnings.module';
import { InstructorsModule } from './instructors/instructors.module';
import { LearningModule } from './learning/learning.module';
import { MarketplaceNotificationsModule } from './notifications/notifications.module';
import { PayoutsModule } from './payouts/payouts.module';
import { RefundsModule } from './refunds/refunds.module';
import { ReviewsModule } from './reviews/reviews.module';

/**
 * The entire Professional Courses Marketplace feature, aggregated behind
 * one module boundary (plan.md §Project Structure). Nothing in the rest of
 * the application imports this module back — the dependency arrow points
 * one way, which is what lets `MARKETPLACE_ENABLED=false` remove the
 * feature from the running application without touching academic code
 * (FR-005). See `isMarketplaceEnabled()` in `config/marketplace.config.ts`
 * for the flag `app.module.ts` reads before importing this at all.
 *
 * Reuses (never duplicates) the platform's existing capabilities: the
 * payment gateway and commission arithmetic (`PaymentsModule`), private
 * object storage (`StorageModule`), the notification pipeline
 * (`NotificationsModule`), certificate rendering and verification
 * (`CertificatesModule`), idempotency (`IdempotencyModule`), background
 * jobs (`QueuesModule`) and the audit-event pipeline (`ActivityLogsModule`).
 */
@Module({
  imports: [
    PaymentsModule,
    StorageModule,
    NotificationsModule,
    CertificatesModule,
    IdempotencyModule,
    QueuesModule,
    ActivityLogsModule,
    MarketplaceCommonModule,
    InstructorsModule,
    CatalogModule,
    DiscoveryModule,
    CommerceModule,
    EarningsModule,
    PayoutsModule,
    RefundsModule,
    ReviewsModule,
    MarketplaceAdminModule,
    MarketplaceNotificationsModule,
    LearningModule,
  ],
})
export class MarketplaceModule implements NestModule {
  /**
   * FR-303, FR-330, T208/T213. Every marketplace response is `no-store` by
   * default — that is the safe default for a module dominated by
   * financial, ownership-scoped and signed-content data — except the small,
   * genuinely public, anonymous catalogue surface, which gets its own short
   * public cache instead (T213's caching implementation) rather than none
   * at all. Paths below are given without the global API prefix, matching
   * every other `NestModule.configure()` in this codebase (`BooksModule`).
   */
  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(NoStoreMiddleware)
      .exclude(
        { path: 'marketplace/courses', method: RequestMethod.GET },
        { path: 'marketplace/courses/:slug', method: RequestMethod.GET },
        { path: 'marketplace/courses/:slug/curriculum', method: RequestMethod.GET },
        { path: 'marketplace/courses/:slug/reviews', method: RequestMethod.GET },
        { path: 'marketplace/categories', method: RequestMethod.GET },
        { path: 'marketplace/instructors/:slug', method: RequestMethod.GET },
      )
      .forRoutes('*');
  }
}
