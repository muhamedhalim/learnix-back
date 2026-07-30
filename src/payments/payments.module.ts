import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { DiscountCodesModule } from '../discount-codes/discount-codes.module';
// External modules
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { AdminPaymentsController } from './controllers/admin-payments.controller';
import { AdminFinanceController } from './controllers/admin-finance.controller';
import { ManualPaymentsController } from './controllers/manual-payments.controller';
import { OrdersController } from './controllers/orders.controller';
// Controllers
import { PaymentsController } from './controllers/payments.controller';
import { PaymentsWebhookController } from './controllers/payments-webhook.controller';
import { TeacherFinanceController } from './controllers/teacher-finance.controller';
import { TeacherPaymentsController } from './controllers/teacher-payments.controller';
// Entities
import {
  Entitlement,
  FinancialLedgerEntry,
  GatewayWebhookEvent,
  LessonPurchase,
  ManualPaymentMethod,
  ManualPaymentSubmission,
  Order,
  PackagePurchase,
  Payment,
  PaymentAuditLog,
  PaymentDomainEvent,
  Refund,
  RefundAttempt,
  Settlement,
  SettlementEntry,
} from './entities';
import { PAYMENT_GATEWAY } from './providers/payment-gateway.interface';
import { PaymobGateway } from './providers/paymob/paymob.gateway';
// Services
import { CommissionService } from './services/commission.service';
import { EntitlementsService } from './services/entitlements.service';
import { GatewayWebhookService } from './services/gateway-webhook.service';
import { ManualPaymentsService } from './services/manual-payments.service';
import { OrdersService } from './services/orders.service';
import { PaymentFinalizationService } from './services/payment-finalization.service';
import { PaymentOperationsService } from './services/payment-operations.service';
import { PaymentProviderRegistry } from './services/payment-provider-registry.service';
import { PaymentsService } from './services/payments.service';
import { RefundsService } from './services/refunds.service';
import { SettlementsService } from './services/settlements.service';

@Module({
  imports: [
    forwardRef(() => DiscountCodesModule),
    ConfigModule,
    TypeOrmModule.forFeature([
      Payment,
      // Manual method administration writes mandatory payment audit records.
      // Register the exact barrel-exported class that services use with
      // DataSource/EntityManager so autoLoadEntities includes its metadata.
      PaymentAuditLog,
      Order,
      Entitlement,
      FinancialLedgerEntry,
      ManualPaymentMethod,
      ManualPaymentSubmission,
      Refund,
      RefundAttempt,
      Settlement,
      SettlementEntry,
      GatewayWebhookEvent,
      PaymentDomainEvent,
      LessonPurchase,
      PackagePurchase,
      Lesson,
      LessonPackage,
      Book,
      BookPurchase,
    ]),
  ],
  controllers: [
    AdminPaymentsController,
    AdminFinanceController,
    PaymentsController,
    OrdersController,
    ManualPaymentsController,
    PaymentsWebhookController,
    TeacherPaymentsController,
    TeacherFinanceController,
  ],
  providers: [
    PaymentsService,
    PaymobGateway,
    {
      provide: PAYMENT_GATEWAY,
      useExisting: PaymobGateway,
    },
    PaymentProviderRegistry,
    CommissionService,
    OrdersService,
    EntitlementsService,
    PaymentFinalizationService,
    ManualPaymentsService,
    RefundsService,
    SettlementsService,
    PaymentOperationsService,
    GatewayWebhookService,
  ],
  exports: [
    PaymentsService,
    PAYMENT_GATEWAY,
    CommissionService,
    OrdersService,
    EntitlementsService,
    PaymentFinalizationService,
  ],
})
export class PaymentsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Payment services ready
  }
}
