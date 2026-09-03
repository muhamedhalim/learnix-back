import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../../activity-logs/activity-logs.module';
import { PaymentsModule } from '../../payments/payments.module';
import { EarningsModule } from '../earnings/earnings.module';
import { InstructorsModule } from '../instructors/instructors.module';
import { AdminPayoutController } from './controllers/admin-payout.controller';
import { InstructorPayoutController } from './controllers/instructor-payout.controller';
import { MarketplacePayoutAccount, MarketplacePayoutRequest } from './entities';
import { PayoutAccountService } from './payout-account.service';
import { PayoutAdminService } from './payout-admin.service';
import { PayoutRequestService } from './payout-request.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplacePayoutAccount, MarketplacePayoutRequest]),
    // FR-226: FinancePermissionsGuard on the admin controller.
    PaymentsModule,
    EarningsModule,
    // `ApprovedInstructorGuard`/`@CurrentInstructor()` for InstructorPayoutController.
    InstructorsModule,
    ActivityLogsModule,
  ],
  controllers: [InstructorPayoutController, AdminPayoutController],
  providers: [PayoutAccountService, PayoutRequestService, PayoutAdminService],
  exports: [TypeOrmModule, PayoutAccountService, PayoutRequestService, PayoutAdminService],
})
export class PayoutsModule {}
