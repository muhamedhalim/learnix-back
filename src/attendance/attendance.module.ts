import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttendanceRecord, LessonSession } from './entities';
import { AttendanceService } from './attendance.service';
import {
  SessionController,
  StudentAttendanceController,
  TeacherAttendanceController,
  AdminAttendanceController,
} from './controllers';
import { Lesson } from '../lessons/entities/lesson.entity';
import { NotificationsModule } from '../notifications/notifications.module';

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
