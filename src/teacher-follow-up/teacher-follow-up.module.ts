import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { StudentGuardian } from '../guardians/entities';
import { GuardiansModule } from '../guardians/guardians.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { HomeworkSubmission } from '../lessons/entities/homework-submission.entity';
import { LessonHomework } from '../lessons/entities/lesson-homework.entity';
import { ParentMessage } from '../notifications/entities';
import { NotificationsModule } from '../notifications/notifications.module';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import {
  TeacherBroadcastController,
  TeacherGuardiansController,
  TeacherParentMessagesController,
  TeacherStudentsController,
} from './controllers';
import { TeacherBroadcastService } from './teacher-broadcast.service';
import { TeacherFollowUpService } from './teacher-follow-up.service';
import { TeacherTimelineService } from './teacher-timeline.service';

/**
 * The teacher-facing "Parents & Follow-up" surface: read-only student roster,
 * guardian visibility, scoped notification history, and manual broadcasts.
 *
 * Depends on `GuardiansModule` and `NotificationsModule` for their existing
 * services rather than re-implementing eligibility or delivery — a teacher
 * broadcast rides the exact same event → queue → channel pipeline every
 * automatic notification does.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Lesson,
      LessonHomework,
      HomeworkSubmission,
      LessonPurchase,
      PackagePurchase,
      ExamAttempt,
      AttendanceRecord,
      LessonSession,
      ParentMessage,
      StudentGuardian,
    ]),
    GuardiansModule,
    NotificationsModule,
  ],
  controllers: [
    TeacherStudentsController,
    TeacherGuardiansController,
    TeacherParentMessagesController,
    TeacherBroadcastController,
  ],
  providers: [TeacherFollowUpService, TeacherTimelineService, TeacherBroadcastService],
  exports: [TeacherFollowUpService],
})
export class TeacherFollowUpModule {}
