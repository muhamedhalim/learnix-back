import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { ExamQuestion } from '../exams/entities/exam-question.entity';
import { Question } from '../exams/entities/question.entity';
import { QuestionSolve } from '../gamification/entities/question-solve.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { HomeworkSubmission } from '../lessons/entities/homework-submission.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { Payment } from '../payments/entities/payment.entity';
import { LessonReview } from '../reviews/entities/lesson-review.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { DistributedSingleFlightService } from './distributed-single-flight.service';
import { QuizAnalyticsController } from './quiz-analytics.controller';
import { QuizAnalyticsService } from './quiz-analytics.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Lesson,
      Book,
      Exam,
      LessonPurchase,
      PackagePurchase,
      Payment,
      BookPurchase,
      ExamAttempt,
      ExamQuestion,
      ExamAttemptAnswer,
      Question,
      LessonSession,
      LessonReview,
      AttendanceRecord,
      QuestionSolve,
      HomeworkSubmission,
      LessonProgress,
      Subject,
    ]),
  ],
  controllers: [AnalyticsController, QuizAnalyticsController],
  providers: [AnalyticsService, DistributedSingleFlightService, QuizAnalyticsService],
  exports: [AnalyticsService, QuizAnalyticsService],
})
export class AnalyticsModule {}
