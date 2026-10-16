import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IdempotencyModule } from '../../idempotency/idempotency.module';
import { PaymentsModule } from '../../payments/payments.module';
import { PerAccountThrottlerGuard } from '../common/guards/per-account-throttler.guard';
import { DiscoveryModule } from '../discovery/discovery.module';
import { EarningsModule } from '../earnings/earnings.module';
import { AccessService } from './access.service';
import { MarketplaceCheckoutService } from './checkout.service';
import { FreeEnrollmentController } from './controllers/free-enrollment.controller';
import { LearnerCheckoutController } from './controllers/learner-checkout.controller';
import { LearnerOrdersController } from './controllers/learner-orders.controller';
import { EnrollmentService } from './enrollment.service';
import { MarketplaceEnrollment, MarketplaceLessonProgress, MarketplaceOrder } from './entities';
import { FreeEnrollmentService } from './free-enrollment.service';
import { MarketplaceSettlementListener } from './listeners/marketplace-settlement.listener';
import { MarketplaceOrderService } from './order.service';
import { MarketplaceSettlementService } from './settlement.service';

/**
 * Orders, payments, enrollment and access (plan.md's Commerce module, T093
 * – T105). `PaymentsModule` supplies `PAYMENT_GATEWAY` + the shared
 * `Payment`/`TypeOrmModule` repositories + `GatewayWebhookService`;
 * `DiscoveryModule` supplies `CatalogQueryService` for the FR-103 purchase
 * gate; `EarningsModule` supplies `MarketplaceCommissionService` +
 * `LedgerService`; `IdempotencyModule` backs the checkout endpoint's
 * required `Idempotency-Key`. None of these import this module back.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplaceOrder, MarketplaceEnrollment, MarketplaceLessonProgress]),
    PaymentsModule,
    DiscoveryModule,
    EarningsModule,
    IdempotencyModule,
  ],
  controllers: [LearnerCheckoutController, LearnerOrdersController, FreeEnrollmentController],
  providers: [
    MarketplaceOrderService,
    MarketplaceCheckoutService,
    MarketplaceSettlementService,
    MarketplaceSettlementListener,
    EnrollmentService,
    AccessService,
    FreeEnrollmentService,
    PerAccountThrottlerGuard,
  ],
  exports: [TypeOrmModule, EnrollmentService, AccessService, MarketplaceOrderService],
})
export class CommerceModule {}
