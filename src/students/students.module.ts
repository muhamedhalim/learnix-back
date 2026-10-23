import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MetricsModule } from '../common/metrics';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { GuardiansModule } from '../guardians/guardians.module';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminStudentsController,
  StudentProfileController,
  StudentsController,
} from './controllers';
import { StudentProfile } from './entities/student-profile.entity';
import { StudentsService } from './students.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudentProfile,
      User,
      LessonPurchase,
      ExamAttempt,
    ]),
    GuardiansModule,
    MetricsModule,
    ActivityLogsModule,
  ],
  controllers: [
    AdminStudentsController,
    StudentProfileController,
    StudentsController,
  ],
  providers: [StudentsService],
  exports: [StudentsService, TypeOrmModule],
})
export class StudentsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Student services ready
  }
}
