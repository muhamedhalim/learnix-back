import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationsModule } from '../notifications/notifications.module';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { User } from '../users/entities/user.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { UploadModule } from '../uploads/upload.module';
import { ComplaintsService } from './complaints.service';
import { ComplaintsAdminController } from './controllers/complaints-admin.controller';
import { ComplaintsCallCenterController } from './controllers/complaints-call-center.controller';
import { ComplaintsStudentController } from './controllers/complaints-student.controller';
import { ComplaintsTeacherController } from './controllers/complaints-teacher.controller';
import { ComplaintMessage } from './entities/complaint-message.entity';
import { ComplaintAttachment } from './entities/complaint-attachment.entity';
import { ComplaintStatusPeriod } from './entities/complaint-status-period.entity';
import { Complaint } from './entities/complaint.entity';
import { SupportSlaService } from './support-sla.service';
import { SupportManagementService } from './support-management.service';
import { SupportManagementAdminController } from './controllers/support-management-admin.controller';
import { SupportCannedResponse } from './entities/support-canned-response.entity';
import { SupportKnowledgeArticle } from './entities/support-knowledge-article.entity';
import { SupportSlaPolicy } from './entities/support-sla-policy.entity';

@Module({
  imports: [
    ActivityLogsModule,
    NotificationsModule,
    UploadModule,
    TypeOrmModule.forFeature([
      Complaint,
      ComplaintAttachment,
      ComplaintMessage,
      ComplaintStatusPeriod,
      StudentProfile,
      User,
      Lesson,
      SupportCannedResponse,
      SupportKnowledgeArticle,
      SupportSlaPolicy,
    ]),
  ],
  providers: [ComplaintsService, SupportSlaService, SupportManagementService],
  controllers: [
    ComplaintsAdminController,
    ComplaintsCallCenterController,
    ComplaintsStudentController,
    ComplaintsTeacherController,
    SupportManagementAdminController,
  ],
  exports: [ComplaintsService, SupportManagementService],
})
export class ComplaintsModule {}
