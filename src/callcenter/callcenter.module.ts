import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { Complaint } from '../complaints/entities/complaint.entity';
import { FinancialLedgerEntry, Order, Payment, Settlement } from '../payments/entities';
import { GuardiansModule } from '../guardians/guardians.module';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { StudentsModule } from '../students/students.module';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { CallCenterController } from './callcenter.controller';
import { CallCenterSupportService } from './callcenter-support.service';

@Module({
  imports: [
    ActivityLogsModule,
    GuardiansModule,
    StudentsModule,
    UsersModule,
    TypeOrmModule.forFeature([
      Complaint,
      StudentProfile,
      TeacherProfile,
      User,
      Order,
      Payment,
      Settlement,
      FinancialLedgerEntry,
    ]),
  ],
  controllers: [CallCenterController],
  providers: [CallCenterSupportService],
})
export class CallCenterModule {}
