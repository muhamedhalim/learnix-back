import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReviewsService } from './reviews.service';
import { TeacherReview, LessonReview } from './entities';
import { User } from '../users/entities/user.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import {
  ReviewsPublicController,
  ReviewsStudentController,
} from './controllers';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TeacherReview,
      LessonReview,
      User,
      Lesson,
      LessonPurchase,
      PackagePurchase,
    ]),
  ],
  providers: [ReviewsService],
  controllers: [ReviewsPublicController, ReviewsStudentController],
  exports: [ReviewsService],
})
export class ReviewsModule {}
