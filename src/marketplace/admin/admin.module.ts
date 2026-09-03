import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PaymentsModule } from '../../payments/payments.module';
import { MarketplaceCourse } from '../catalog/entities';
import { CommerceModule } from '../commerce/commerce.module';
import { EarningsModule } from '../earnings/earnings.module';
import { InstructorsModule } from '../instructors/instructors.module';
import { MarketplacePayoutRequest } from '../payouts/entities';
import { MarketplaceRefundRequest } from '../refunds/entities';
import { AdminInstructorsController } from './controllers/admin-instructors.controller';
import { AdminLedgerController } from './controllers/admin-ledger.controller';
import { AdminOverviewController } from './controllers/admin-overview.controller';
import { AdminReportingController } from './controllers/admin-reporting.controller';
import { MarketplaceExportService } from './export.service';
import { FeaturedCourseService } from './featured.service';
import { InstructorAdminService } from './instructor-admin.service';
import { MoneyTrailService } from './money-trail.service';
import { MarketplaceOverviewService } from './overview.service';
import { MarketplaceReportingService } from './reporting.service';

/**
 * Console read models and cross-cutting admin ops (plan.md's `admin/`
 * module). `MarketplaceRefundRequest`/`MarketplacePayoutRequest`/
 * `MarketplaceCourse` are re-registered directly here (the same pattern
 * `ReviewsModule` already established) rather than importing `RefundsModule`/
 * `PayoutsModule`/`CatalogModule` wholesale — this module only ever needs
 * their repositories, never `RefundRequestService`/`PayoutRequestService`/
 * `CourseAuthoringService` themselves, and importing those modules would
 * pull in far more than needed for no benefit. `EarningsModule` and
 * `InstructorsModule` ARE imported properly (not re-registered), since this
 * module genuinely reuses their services (`BalanceService`, `LedgerService`,
 * `AdjustmentService`, `ReconciliationService`, `MarketplaceCommissionService`,
 * `InstructorService`, `InstructorProfileService`) directly. `PaymentsModule`
 * supplies `FinancePermissionsGuard` (and its own `User` repository
 * dependency), matching every other `Finance`-gated admin controller in
 * this feature.
 */
@Module({
  imports: [
    CommerceModule,
    EarningsModule,
    InstructorsModule,
    PaymentsModule,
    TypeOrmModule.forFeature([MarketplaceRefundRequest, MarketplacePayoutRequest, MarketplaceCourse]),
  ],
  controllers: [AdminOverviewController, AdminInstructorsController, AdminReportingController, AdminLedgerController],
  providers: [
    MarketplaceReportingService,
    MoneyTrailService,
    MarketplaceOverviewService,
    MarketplaceExportService,
    FeaturedCourseService,
    InstructorAdminService,
  ],
  exports: [MarketplaceReportingService, MoneyTrailService, FeaturedCourseService],
})
export class MarketplaceAdminModule {}
