import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationsModule } from '../notifications/notifications.module';
import { ComplaintsService } from './complaints.service';
import { ComplaintsAdminController } from './controllers/complaints-admin.controller';
import { ComplaintsStudentController } from './controllers/complaints-student.controller';
import { Complaint } from './entities/complaint.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Complaint]), NotificationsModule],
  providers: [ComplaintsService],
  controllers: [ComplaintsStudentController, ComplaintsAdminController],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
