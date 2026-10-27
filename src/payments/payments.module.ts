import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Cart } from '../cart/entities/cart.entity';
import { CartItem } from '../cart/entities/cart-item.entity';
import { CertificatesModule } from '../certificates/certificates.module';
import { User } from '../users/entities/user.entity';
import { DiscountCodesModule } from '../discount-codes/discount-codes.module';
// External modules
import { Lesson } from '../lessons/entities/lesson.entity';
import { ScheduledLessonSession } from '../lessons/entities/scheduled-lesson-session.entity';
import { LessonSessionBooking } from '../lessons/entities/lesson-session-booking.entity';
import { LessonSessionNotificationService } from '../lessons/lesson-session-notification.service';
import { LessonSessionsService } from '../lessons/lesson-sessions.service';
import { MeetingsModule } from '../lessons/meetings/meetings.module';
import { MeetingProvisioningProcessor } from '../lessons/processors/meeting-provisioning.processor';
import { NotificationsModule } from '../notifications/notifications.module';
import { ObservabilityModule } from '../observability/observability.module';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { AdminPaymentsController } from './controllers/admin-payments.controller';
import { AdminFinanceController } from './controllers/admin-finance.controller';
import { ManualPaymentsController } from './controllers/manual-payments.controller';
import { OrdersController } from './controllers/orders.controller';
// Controllers
import { PaymentsController } from './controllers/payments.controller';
import { PaymentsWebhookController } from './controllers/payments-webhook.controller';
import { PaymentsReturnController } from './controllers/payments-return.controller';
import { TeacherFinanceController } from './controllers/teacher-finance.controller';
import { TeacherPaymentsController } from './controllers/teacher-payments.controller';
// Entities
import {
  Entitlement,
  CartCheckout,
  FinancialLedgerEntry,
  FinancialMaintenanceRun,
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
import { EasyKashGateway } from './providers/easykash/easykash.gateway';
// Services
import { CommissionService } from './services/commission.service';
import { CartCheckoutService } from './services/cart-checkout.service';
import { EntitlementsService } from './services/entitlements.service';
import { GatewayWebhookService } from './services/gateway-webhook.service';
import { GatewayFinancialStateMachineService } from './services/gateway-financial-state-machine.service';
import { ManualPaymentsService } from './services/manual-payments.service';
import { OrdersService } from './services/orders.service';
import { PaymentFinalizationService } from './services/payment-finalization.service';
import { FinancialReportsService } from './services/financial-reports.service';
import { PaymentOperationsService } from './services/payment-operations.service';
import { PaymentProviderRegistry } from './services/payment-provider-registry.service';
import { FinancePermissionsGuard } from './guards/finance-permissions.guard';
import { PaymentsService } from './services/payments.service';
import { RefundsService } from './services/refunds.service';
import { FinanceAuditService } from './services/finance-audit.service';
import { SettlementsService } from './services/settlements.service';

@Module({
  imports: [
    DiscountCodesModule,
    ConfigModule,
    // Supplies ScheduledJobMonitorService to the payment-critical @Cron jobs
    // (finance maintenance, gateway reconciliation, webhook recovery). Safe to
    // import: ObservabilityModule has no module dependencies of its own.
    ObservabilityModule,
    // Supplies NotificationEmailService to LessonSessionsService (provided
    // here), so session lifecycle mail passes the `email_enabled` channel
    // policy instead of calling MailService directly. The existing indirect
    // module cycle is resolved without changing that provider dependency.
    NotificationsModule,
    // Supplies CertificateEligibilityService so a completed FULL refund can
    // revoke the course certificate inside the refund transaction (DEF-019).
    // CertificatesModule imports only NotificationsModule + TypeORM features,
    // so this arrow does not close a cycle.
    CertificatesModule,
    // Supplies MeetingProviderRegistry + MeetingAccountsService to
    // LessonSessionsService (provided here) for the explicit per-appointment
    // Generate action (Phase 5, R-4). One-directional: MeetingsModule has no
    // dependency on PaymentsModule or LessonsModule, so this closes no cycle.
    MeetingsModule,
    // Registers the meeting-provisioning queue alongside the service and
    // worker that own it — the same domain-local pattern AttendanceCodesModule
    // uses for its own queues.
    registerQueues({
      name: QUEUE_NAMES.MEETING_PROVISIONING,
      config: QUEUE_CONFIGS[QUEUE_NAMES.MEETING_PROVISIONING],
    }),
    TypeOrmModule.forFeature([
      Payment,
      CartCheckout,
      // Manual method administration writes mandatory payment audit records.
      // Register the exact barrel-exported class that services use with
      // DataSource/EntityManager so autoLoadEntities includes its metadata.
      PaymentAuditLog,
      Order,
      Entitlement,
      FinancialLedgerEntry,
      FinancialMaintenanceRun,
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
      ScheduledLessonSession,
      LessonSessionBooking,
      LessonPackage,
      Book,
      BookPurchase,
      Cart,
      CartItem,
      User,
    ]),
  ],
  controllers: [
    AdminPaymentsController,
    AdminFinanceController,
    PaymentsController,
    OrdersController,
    ManualPaymentsController,
    PaymentsWebhookController,
    PaymentsReturnController,
    TeacherPaymentsController,
    TeacherFinanceController,
  ],
  providers: [
    PaymentsService,
    EasyKashGateway,
    {
      provide: PAYMENT_GATEWAY,
      useExisting: EasyKashGateway,
    },
    PaymentProviderRegistry,
    CommissionService,
    CartCheckoutService,
    OrdersService,
    EntitlementsService,
    PaymentFinalizationService,
    ManualPaymentsService,
    RefundsService,
    SettlementsService,
    FinanceAuditService,
    PaymentOperationsService,
    FinancialReportsService,
    GatewayWebhookService,
    GatewayFinancialStateMachineService,
    LessonSessionsService,
    LessonSessionNotificationService,
    FinancePermissionsGuard,
    // Worker needs a real queue connection to pull jobs from; skip it
    // entirely when queues are disabled rather than let it attempt one.
    ...(areQueuesEnabled() ? [MeetingProvisioningProcessor] : []),
  ],
  exports: [
    // The marketplace reuses the shared `Payment` entity/table directly
    // (item_type = 'marketplace_course') rather than a second payments
    // schema — see `payments/entities/item-type.enum.ts` and
    // `GatewayFinancialStateMachineService.apply()`'s marketplace branch.
    // Exporting `TypeOrmModule` is additive: it only makes already-registered
    // repositories injectable elsewhere, and changes nothing for the
    // services above that already had access to them.
    TypeOrmModule,
    PaymentsService,
    PAYMENT_GATEWAY,
    CommissionService,
    CartCheckoutService,
    OrdersService,
    EntitlementsService,
    PaymentFinalizationService,
    PaymentOperationsService,
    FinancialReportsService,
    LessonSessionsService,
    // Lets marketplace code reuse the exact same HMAC-verified,
    // idempotency-guarded webhook entry point academic checkout uses,
    // rather than a second implementation.
    GatewayWebhookService,
    // Lets marketplace refund processing (T136) resolve the same
    // provider-by-name registry the academic RefundsService uses, instead
    // of a second implementation; and lets marketplace admin refund
    // routes (T141) reuse the same `marketplace.*` finance-permission gate
    // every other admin finance route already uses.
    PaymentProviderRegistry,
    FinancePermissionsGuard,
  ],
})
export class PaymentsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Payment services ready
  }
}
