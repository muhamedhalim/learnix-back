import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationsModule } from '../notifications/notifications.module';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { User } from '../users/entities/user.entity';
import { ComplaintsService } from './complaints.service';
import { ComplaintsAdminController } from './controllers/complaints-admin.controller';
import { ComplaintsCallCenterController } from './controllers/complaints-call-center.controller';
import { ComplaintsStudentController } from './controllers/complaints-student.controller';
import { ComplaintsTeacherController } from './controllers/complaints-teacher.controller';
import { ComplaintMessage } from './entities/complaint-message.entity';
import { ComplaintStatusPeriod } from './entities/complaint-status-period.entity';
import { Complaint } from './entities/complaint.entity';

@Module({
  imports: [
    ActivityLogsModule,
    NotificationsModule,
    TypeOrmModule.forFeature([Complaint, ComplaintMessage, ComplaintStatusPeriod, StudentProfile, User]),
  ],
  providers: [ComplaintsService],
  controllers: [
    ComplaintsAdminController,
    ComplaintsCallCenterController,
    ComplaintsStudentController,
    ComplaintsTeacherController,
  ],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
