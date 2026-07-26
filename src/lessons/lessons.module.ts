import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UploadModule } from '../uploads/upload.module';
import {
  AdminLessonsController,
  LessonsController,
  StudentLessonsController,
  TeacherLessonsController,
} from './controllers';
import { TeacherLessonContentController } from './controllers/teacher-lesson-content.controller';
import { StudentHomeworkController } from './controllers/student-homework.controller';
import { TeacherHomeworkController } from './controllers/teacher-homework.controller';
import { BunnyStreamService } from './bunny-stream.service';
import { Lesson } from './entities/lesson.entity';
import { LessonVideoUploadSession } from './entities/lesson-video-upload-session.entity';
import { LessonAttachment } from './entities/lesson-attachment.entity';
import { LessonHomework } from './entities/lesson-homework.entity';
import { HomeworkSubmission } from './entities/homework-submission.entity';
import { LessonNote } from './entities/lesson-note.entity';
import { LessonProgress } from './entities/lesson-progress.entity';
import { LessonContentService } from './lesson-content.service';
import { TeacherHomeworkService } from './teacher-homework.service';
import { LessonsService } from './lessons.service';
import { ProgressService } from './progress.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Lesson,
      LessonVideoUploadSession,
      LessonProgress,
      LessonAttachment,
      LessonHomework,
      HomeworkSubmission,
      LessonNote,
      LessonPurchase,
      PackagePurchase,
      User,
      Subject,
    ]),
    PaymentsModule,
    MediaModule,
    NotificationsModule,
    UploadModule,
  ],
  controllers: [
    AdminLessonsController,
    LessonsController,
    StudentLessonsController,
    TeacherLessonsController,
    TeacherLessonContentController,
    StudentHomeworkController,
    TeacherHomeworkController,
  ],
  providers: [
    LessonsService,
    ProgressService,
    LessonContentService,
    TeacherHomeworkService,
    BunnyStreamService,
  ],
  exports: [LessonsService, ProgressService, BunnyStreamService, TypeOrmModule],
})
export class LessonsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Lesson services ready
  }
}
