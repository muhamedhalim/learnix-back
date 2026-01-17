import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentProfile } from './entities/student-profile.entity';
import { User } from '../users/entities/user.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { StudentsService } from './students.service';
import {
  StudentsController,
  StudentProfileController,
  AdminStudentsController,
} from './controllers';

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
export class StudentsModule {}
