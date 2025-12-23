import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseCode } from './entities';
import { Payment, LessonPurchase, PackagePurchase } from '../payments/entities';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { PurchaseCodesService } from './purchase-codes.service';
import {
  PurchaseCodesController,
  AdminPurchaseCodesController,
} from './controllers';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PurchaseCode,
      Payment,
      LessonPurchase,
      PackagePurchase,
      Lesson,
      LessonPackage,
    ]),
  ],
  controllers: [PurchaseCodesController, AdminPurchaseCodesController],
  providers: [PurchaseCodesService],
  exports: [PurchaseCodesService],
})
export class PurchaseCodesModule {}
