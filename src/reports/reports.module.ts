import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Exam } from '../exams/entities';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { LessonReview } from '../reviews/entities/lesson-review.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { TeacherFollowUpModule } from '../teacher-follow-up/teacher-follow-up.module';
import { User } from '../users/entities/user.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Lesson,
      Book,
      Exam,
      LessonPurchase,
      PackagePurchase,
      BookPurchase,
      ExamAttempt,
      LessonSession,
      LessonReview,
      LessonProgress,
      Subject,
      LessonPackage,
    ]),
    TeacherFollowUpModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
