import { MODULE_METADATA } from '@nestjs/common/constants';

import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { QueuesModule } from '../queues/queues.module';
import { StorageModule } from '../storage/storage.module';
import { MarketplaceAdminModule } from './admin/admin.module';
import { CatalogModule } from './catalog/catalog.module';
import { CommerceModule } from './commerce/commerce.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { EarningsModule } from './earnings/earnings.module';
import { InstructorsModule } from './instructors/instructors.module';
import { LearningModule } from './learning/learning.module';
import { MarketplaceModule } from './marketplace.module';
import { MarketplaceNotificationsModule } from './notifications/notifications.module';
import { PayoutsModule } from './payouts/payouts.module';
import { RefundsModule } from './refunds/refunds.module';
import { ReviewsModule } from './reviews/reviews.module';

/**
 * The full DI-graph compilation (real TypeORM repositories, a real
 * database) is proven by `createE2EApp()` once `MarketplaceModule` is
 * registered in `app.module.ts` (T002) — every marketplace `*.postgres.e2e-spec.ts`
 * that boots the app is that proof. This unit spec checks the piece that
 * doesn't need a database at all: the module's static metadata is exactly
 * what T001 requires.
 */
describe('MarketplaceModule metadata', () => {
  const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MarketplaceModule) ?? []) as unknown[];

  it('imports every reused platform capability named in plan.md', () => {
    expect(imports).toEqual(
      expect.arrayContaining([
        PaymentsModule,
        StorageModule,
        NotificationsModule,
        CertificatesModule,
        IdempotencyModule,
        QueuesModule,
        ActivityLogsModule,
      ]),
    );
  });

  it('imports every marketplace sub-module that owns entities today', () => {
    expect(imports).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it('exports nothing — nothing outside the feature is meant to reach into it directly', () => {
    const exportsList = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, MarketplaceModule) ?? []) as unknown[];
    expect(exportsList).toHaveLength(0);
  });

  it('declares no controllers of its own — every route lives in a sub-module', () => {
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MarketplaceModule) ?? []) as unknown[];
    expect(controllers).toHaveLength(0);
  });
});
