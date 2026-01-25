import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase, PackagePurchase,Payment } from '../payments/entities';
import { AttendanceCodesService } from './attendance-codes.service';
import {
  AdminAttendanceCodesController,
  AttendanceCodesController,
} from './controllers';
import { AttendanceCode } from './entities';

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
