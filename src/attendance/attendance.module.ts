import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AttendanceService } from './attendance.service';
import {
  AdminAttendanceController,
  SessionController,
  StudentAttendanceController,
  TeacherAttendanceController,
} from './controllers';
import { AttendanceRecord, LessonSession } from './entities';

@Module({
  imports: [
    NotificationsModule,
    TypeOrmModule.forFeature([AttendanceRecord, LessonSession, Lesson]),
  ],
  controllers: [
    AdminAttendanceController,
    SessionController,
    StudentAttendanceController,
    TeacherAttendanceController,
  ],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
