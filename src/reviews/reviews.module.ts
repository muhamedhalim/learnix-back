import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import {
  ReviewsPublicController,
  ReviewsStudentController,
} from './controllers';
import { LessonReview, TeacherReview } from './entities';
import { ReviewsService } from './reviews.service';

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
export class ReviewsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Review services ready
  }
}
