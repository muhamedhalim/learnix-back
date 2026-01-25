import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
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
  ],
  controllers: [
    StudentsController,
    StudentProfileController,
    AdminStudentsController,
  ],
  providers: [StudentsService],
  exports: [StudentsService, TypeOrmModule],
})
export class StudentsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Student services ready
  }
}
