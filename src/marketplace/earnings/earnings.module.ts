import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../../activity-logs/activity-logs.module';
import { PaymentsModule } from '../../payments/payments.module';
import { CurrencyRegistryService } from '../common/currency-registry.service';
import { MarketplaceMoneyService } from '../common/money.service';
import { InstructorsModule } from '../instructors/instructors.module';
import { AdjustmentService } from './adjustment.service';
import { BalanceService } from './balance.service';
import { MarketplaceCommissionService } from './commission.service';
import { InstructorEarningsController } from './controllers/instructor-earnings.controller';
import { InstructorLedgerController } from './controllers/instructor-ledger.controller';
import { EarningsService } from './earnings.service';
import {
  InstructorEarning,
  MarketplaceCommissionSetting,
  MarketplaceCurrency,
  MarketplaceLedgerEntry,
} from './entities';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketplaceCurrency,
      MarketplaceCommissionSetting,
      InstructorEarning,
      MarketplaceLedgerEntry,
    ]),
    // FR-135: delegates the actual commission arithmetic to the platform's
    // existing CommissionService rather than a second implementation.
    PaymentsModule,
    // `ApprovedInstructorGuard`/`@CurrentInstructor()` for the two
    // instructor-facing controllers below (T172).
    InstructorsModule,
    ActivityLogsModule,
  ],
  controllers: [InstructorEarningsController, InstructorLedgerController],
  providers: [
    CurrencyRegistryService,
    MarketplaceMoneyService,
    LedgerService,
    MarketplaceCommissionService,
    BalanceService,
    EarningsService,
    ReconciliationService,
    AdjustmentService,
  ],
  exports: [
    TypeOrmModule,
    CurrencyRegistryService,
    MarketplaceMoneyService,
    LedgerService,
    MarketplaceCommissionService,
    BalanceService,
    EarningsService,
    ReconciliationService,
    AdjustmentService,
  ],
})
export class EarningsModule {}
