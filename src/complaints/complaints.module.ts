import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationsModule } from '../notifications/notifications.module';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { ComplaintsService } from './complaints.service';
import { ComplaintsAdminController } from './controllers/complaints-admin.controller';
import { ComplaintsStudentController } from './controllers/complaints-student.controller';
import { Complaint } from './entities/complaint.entity';

@Module({
  imports: [NotificationsModule, TypeOrmModule.forFeature([Complaint, StudentProfile])],
  providers: [ComplaintsService],
  controllers: [ComplaintsAdminController, ComplaintsStudentController],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
