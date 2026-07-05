import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DiscountCodesModule } from '../discount-codes/discount-codes.module';
// External modules
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { AdminPaymentsController } from './controllers/admin-payments.controller';
// Controllers
import { PaymentsController } from './controllers/payments.controller';
import { PaymentsWebhookController } from './controllers/payments-webhook.controller';
import { TeacherPaymentsController } from './controllers/teacher-payments.controller';
// Entities
import { LessonPurchase, PackagePurchase, Payment } from './entities';
// Services
import { PaymentsService } from './services/payments.service';
import { PaymobService } from './services/paymob.service';

@Module({
  imports: [
    forwardRef(() => DiscountCodesModule),
    ConfigModule,
    IdempotencyModule,
    TypeOrmModule.forFeature([Payment, LessonPurchase, PackagePurchase, Lesson, LessonPackage]),
  ],
  controllers: [
    AdminPaymentsController,
    PaymentsController,
    PaymentsWebhookController,
    TeacherPaymentsController,
  ],
  providers: [PaymentsService, PaymobService],
  exports: [PaymentsService, PaymobService],
})
export class PaymentsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Payment services ready
  }
}
