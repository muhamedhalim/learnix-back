import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminReviewsController,
  ReviewsPublicController,
  ReviewsStudentController,
  ReviewsTeacherController,
} from './controllers';
import {
  LessonReview,
  ReviewHelpfulVote,
  TeacherReview,
} from './entities';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TeacherReview,
      LessonReview,
      ReviewHelpfulVote,
      User,
      Lesson,
      LessonProgress,
      LessonPackage,
      LessonPurchase,
      PackagePurchase,
    ]),
  ],
  providers: [ReviewsService],
  controllers: [
    ReviewsPublicController,
    ReviewsStudentController,
    ReviewsTeacherController,
    AdminReviewsController,
  ],
  exports: [ReviewsService],
})
export class ReviewsModule {}
