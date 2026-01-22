import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ComplaintsService } from './complaints.service';
import { Complaint } from './entities/complaint.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { ComplaintsStudentController } from './controllers/complaints-student.controller';
import { ComplaintsAdminController } from './controllers/complaints-admin.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Complaint]), NotificationsModule],
  providers: [ComplaintsService],
  controllers: [ComplaintsStudentController, ComplaintsAdminController],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
