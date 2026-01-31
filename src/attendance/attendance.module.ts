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
    TypeOrmModule.forFeature([AttendanceRecord, LessonSession, Lesson]),
    NotificationsModule,
  ],
  controllers: [
    SessionController,
    StudentAttendanceController,
    TeacherAttendanceController,
    AdminAttendanceController,
  ],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
