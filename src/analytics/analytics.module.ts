import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { ExamQuestion } from '../exams/entities/exam-question.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { LessonReview } from '../reviews/entities/lesson-review.entity';
import { User } from '../users/entities/user.entity';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

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
      ExamQuestion,
      ExamAttemptAnswer,
      LessonSession,
      LessonReview,
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
