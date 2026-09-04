import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../../activity-logs/activity-logs.module';
import { PaymentsModule } from '../../payments/payments.module';
import { MarketplaceReportingService } from '../admin/reporting.service';
import { MarketplaceOrder } from '../commerce/entities';
import { EarningsModule } from '../earnings/earnings.module';
import { InstructorsModule } from '../instructors/instructors.module';
import { MarketplaceRefundRequest } from '../refunds/entities';
import { AdminPayoutController } from './controllers/admin-payout.controller';
import { InstructorPayoutController } from './controllers/instructor-payout.controller';
import { MarketplacePayoutAccount, MarketplacePayoutRequest } from './entities';
import { PayoutAccountService } from './payout-account.service';
import { PayoutAdminService } from './payout-admin.service';
import { PayoutRequestService } from './payout-request.service';

@Module({
  imports: [
    // `MarketplaceOrder`/`MarketplaceRefundRequest` are re-registered directly
    // here (the same "entity registered in more than one module" pattern
    // `MarketplaceAdminModule` itself already uses) purely so
    // `MarketplaceReportingService`'s own repository dependencies resolve —
    // never importing `CommerceModule`/`RefundsModule` wholesale for one
    // service's repos.
    TypeOrmModule.forFeature([MarketplacePayoutAccount, MarketplacePayoutRequest, MarketplaceOrder, MarketplaceRefundRequest]),
    // FR-226: FinancePermissionsGuard on the admin controller.
    PaymentsModule,
    EarningsModule,
    // `ApprovedInstructorGuard`/`@CurrentInstructor()` for InstructorPayoutController.
    InstructorsModule,
    ActivityLogsModule,
  ],
  controllers: [InstructorPayoutController, AdminPayoutController],
  // `MarketplaceReportingService` backs `AdminPayoutController`'s `GET report`
  // route (FR-231) — was referenced by that controller without ever being
  // provided here; a genuine pre-existing DI gap this fix closes.
  providers: [PayoutAccountService, PayoutRequestService, PayoutAdminService, MarketplaceReportingService],
  exports: [TypeOrmModule, PayoutAccountService, PayoutRequestService, PayoutAdminService],
})
export class PayoutsModule {}
