import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttendanceCodesModule } from '../attendance-codes/attendance-codes.module';
import { GuardiansModule } from '../guardians/guardians.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { User } from '../users/entities/user.entity';
import { BulkOperationsController } from './bulk-operations.controller';
import { BulkOperationsService } from './bulk-operations.service';

@Module({
  imports: [
    AttendanceCodesModule,
    GuardiansModule,
    NotificationsModule,
    TypeOrmModule.forFeature([User, Lesson]),
  ],
  controllers: [BulkOperationsController],
  providers: [BulkOperationsService],
  exports: [BulkOperationsService],
})
export class BulkOperationsModule {}
