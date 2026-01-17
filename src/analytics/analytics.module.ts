import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { User } from '../users/entities/user.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { Book } from '../books/entities/book.entity';
import { Exam } from '../exams/entities/exam.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';

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
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
