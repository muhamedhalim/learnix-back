import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { CommentsService } from './comments.service';
import { CommentsAdminController } from './controllers/comments-admin.controller';
import { CommentsPublicController } from './controllers/comments-public.controller';
import { CommentsStudentController } from './controllers/comments-student.controller';
import { CommentsTeacherController } from './controllers/comments-teacher.controller';
import { Comment, CommentReply } from './entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Comment,
      CommentReply,
      Lesson,
      LessonPurchase,
      PackagePurchase,
    ]),
  ],
  providers: [CommentsService],
  controllers: [
    CommentsPublicController,
    CommentsStudentController,
    CommentsTeacherController,
    CommentsAdminController,
  ],
  exports: [CommentsService],
})
export class CommentsModule {}
