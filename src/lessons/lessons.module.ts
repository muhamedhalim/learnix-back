import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MetricsModule } from '../common/metrics';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UploadModule } from '../uploads/upload.module';
import {
  AdminLessonsController,
  LessonsController,
  StudentLessonsController,
  TeacherLessonsController,
  PublicLessonSessionsController,
  StudentLessonSessionsController,
  TeacherLessonSessionsController,
  AdminLessonSessionsController,
} from './controllers';
import { TeacherLessonContentController } from './controllers/teacher-lesson-content.controller';
import { StudentHomeworkController } from './controllers/student-homework.controller';
import { TeacherHomeworkController } from './controllers/teacher-homework.controller';
import { Lesson } from './entities/lesson.entity';
import { LessonAttachment } from './entities/lesson-attachment.entity';
import { LessonHomework } from './entities/lesson-homework.entity';
import { HomeworkSubmission } from './entities/homework-submission.entity';
import { LessonNote } from './entities/lesson-note.entity';
import { LessonProgress } from './entities/lesson-progress.entity';
import { LessonContentService } from './lesson-content.service';
import { TeacherHomeworkService } from './teacher-homework.service';
import { LessonAwsVideoService } from './lesson-aws-video.service';
import { LessonsService } from './lessons.service';
import { VideoModule } from '../video/video.module';
import { ProgressService } from './progress.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Lesson,
      LessonProgress,
      LessonAttachment,
      LessonHomework,
      HomeworkSubmission,
      LessonNote,
      LessonPurchase,
      User,
      Subject,
    ]),
    PaymentsModule,
    MediaModule,
    MetricsModule,
    NotificationsModule,
    ReviewsModule,
    UploadModule,
    VideoModule,
  ],
  controllers: [
    AdminLessonsController,
    LessonsController,
    StudentLessonsController,
    TeacherLessonsController,
    PublicLessonSessionsController,
    StudentLessonSessionsController,
    TeacherLessonSessionsController,
    AdminLessonSessionsController,
    TeacherLessonContentController,
    StudentHomeworkController,
    TeacherHomeworkController,
  ],
  providers: [
    LessonsService,
    ProgressService,
    LessonContentService,
    TeacherHomeworkService,
    LessonAwsVideoService,
  ],
  exports: [LessonsService, ProgressService, LessonAwsVideoService, TypeOrmModule],
})
export class LessonsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Lesson services ready
  }
}
