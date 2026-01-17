import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttendanceCode } from './entities';
import { Payment, LessonPurchase, PackagePurchase } from '../payments/entities';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { AttendanceCodesService } from './attendance-codes.service';
import {
  AttendanceCodesController,
  AdminAttendanceCodesController,
} from './controllers';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttendanceCode,
      Payment,
      LessonPurchase,
      PackagePurchase,
      Lesson,
      LessonPackage,
    ]),
  ],
  controllers: [AttendanceCodesController, AdminAttendanceCodesController],
  providers: [AttendanceCodesService],
  exports: [AttendanceCodesService],
})
export class AttendanceCodesModule {}
