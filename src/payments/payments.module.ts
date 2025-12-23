import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

// Entities
import { Payment, LessonPurchase, PackagePurchase } from './entities';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';

// Services
import { PaymentsService } from './services/payments.service';
import { PaymobService } from './services/paymob.service';

// Controllers
import { PaymentsController } from './controllers/payments.controller';
import { PaymentsWebhookController } from './controllers/payments-webhook.controller';
import { AdminPaymentsController } from './controllers/admin-payments.controller';

// External modules
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { DiscountCodesModule } from '../discount-codes/discount-codes.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      LessonPurchase,
      PackagePurchase,
      Lesson,
      LessonPackage,
    ]),
    ConfigModule,
    IdempotencyModule,
    forwardRef(() => DiscountCodesModule),
  ],
  controllers: [
    PaymentsController,
    PaymentsWebhookController,
    AdminPaymentsController,
  ],
  providers: [PaymentsService, PaymobService],
  exports: [PaymentsService, PaymobService],
})
export class PaymentsModule {}
