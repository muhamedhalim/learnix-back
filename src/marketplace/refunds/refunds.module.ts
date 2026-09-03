import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../../activity-logs/activity-logs.module';
import { IdempotencyModule } from '../../idempotency/idempotency.module';
import { PaymentsModule } from '../../payments/payments.module';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../../queues/queues.constants';
import { registerQueues } from '../../queues/register-queues.util';
import { CatalogModule } from '../catalog/catalog.module';
import { CourseRemovalService } from '../catalog/course-removal.service';
import { MarketplaceRemovalProcessor } from '../catalog/processors/marketplace-removal.processor';
import { CommerceModule } from '../commerce/commerce.module';
import { EarningsModule } from '../earnings/earnings.module';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { AdminCourseRemovalController } from './controllers/admin-course-removal.controller';
import { AdminRefundController } from './controllers/admin-refund.controller';
import { LearnerRefundController } from './controllers/learner-refund.controller';
import { RefundEligibilityService } from './eligibility.service';
import { MarketplaceRefundRequest } from './entities';
import { ClearanceSweepScheduler, ClearanceSweepService } from '../jobs/clearance.job';
import { RefundProcessingService } from './refund-processing.service';
import { RefundRequestService } from './refund-request.service';

/**
 * FR-176 – FR-199 (T133 – T143). `Certificate` and `MarketplaceCourseReview`
 * are mutated by `RefundProcessingService` directly through the
 * transactional `EntityManager` it's handed (never via
 * `@InjectRepository`), so this module needs no dependency on
 * `CertificatesModule` or `ReviewsModule` — both entities are already
 * registered on the shared `DataSource`.
 *
 * `CourseRemovalService`'s file lives under `marketplace/catalog/` (T142's
 * stated path) but is provided HERE: it depends on refund processing, and
 * `CatalogModule` importing this module back would close a cycle
 * (`RefundsModule → CommerceModule → DiscoveryModule → CatalogModule`
 * already exists one-way). Importing `CatalogModule` here instead is a new,
 * non-circular edge into a module already reachable transitively.
 */
@Module({
  imports: [
    // `InstructorEarning` re-registered directly (the same pattern
    // `ReviewsModule` already uses for entities it needs read/write access
    // to without importing their owning module) — `ClearanceSweepService`
    // needs a directly-injected repository, not just manager-level access.
    TypeOrmModule.forFeature([MarketplaceRefundRequest, InstructorEarning]),
    CommerceModule,
    EarningsModule,
    PaymentsModule,
    IdempotencyModule,
    ActivityLogsModule,
    CatalogModule,
    registerQueues({
      name: QUEUE_NAMES.MARKETPLACE,
      config: QUEUE_CONFIGS[QUEUE_NAMES.MARKETPLACE],
    }),
  ],
  controllers: [LearnerRefundController, AdminRefundController, AdminCourseRemovalController],
  providers: [
    RefundEligibilityService,
    RefundProcessingService,
    RefundRequestService,
    CourseRemovalService,
    ClearanceSweepService,
    ...(areQueuesEnabled() ? [MarketplaceRemovalProcessor, ClearanceSweepScheduler] : []),
  ],
  exports: [
    TypeOrmModule,
    RefundEligibilityService,
    RefundProcessingService,
    RefundRequestService,
    CourseRemovalService,
    ClearanceSweepService,
  ],
})
export class RefundsModule {}
