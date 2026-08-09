import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonSessionBooking } from '../lessons/entities/lesson-session-booking.entity';
import { ScheduledLessonSession } from '../lessons/entities/scheduled-lesson-session.entity';
import { PaymentsModule } from '../payments/payments.module';
import { User } from '../users/entities/user.entity';
import { AttendanceService } from './attendance.service';
import { AttendanceExportService } from './attendance-export.service';
import {
  AdminAttendanceController,
  SessionController,
  StudentAttendanceController,
  TeacherAttendanceController,
} from './controllers';
import { AttendanceRecord, LessonSession } from './entities';

@Module({
  imports: [
    // No longer imports NotificationsModule: marking attendance emits a domain
    // event on the app-wide bus and knows nothing about who listens.
    TypeOrmModule.forFeature([
      AttendanceRecord,
      LessonSession,
      Lesson,
      ScheduledLessonSession,
      LessonSessionBooking,
      User,
    ]),
    PaymentsModule,
  ],
  controllers: [
    AdminAttendanceController,
    SessionController,
    StudentAttendanceController,
    TeacherAttendanceController,
  ],
  providers: [AttendanceService, AttendanceExportService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
