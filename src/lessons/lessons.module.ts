import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PaymentsModule } from '../payments/payments.module';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminLessonsController,
  LessonsController,
  StudentLessonsController,
  TeacherLessonsController,
} from './controllers';
import { TeacherLessonContentController } from './controllers/teacher-lesson-content.controller';
import { BunnyStreamService } from './bunny-stream.service';
import { Lesson } from './entities/lesson.entity';
import { LessonAttachment } from './entities/lesson-attachment.entity';
import { LessonHomework } from './entities/lesson-homework.entity';
import { LessonNote } from './entities/lesson-note.entity';
import { LessonProgress } from './entities/lesson-progress.entity';
import { LessonContentService } from './lesson-content.service';
import { LessonsService } from './lessons.service';
import { ProgressService } from './progress.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Lesson,
      LessonProgress,
      LessonAttachment,
      LessonHomework,
      LessonNote,
      User,
      Subject,
    ]),
    PaymentsModule,
  ],
  controllers: [
    AdminLessonsController,
    LessonsController,
    StudentLessonsController,
    TeacherLessonsController,
    TeacherLessonContentController,
  ],
  providers: [
    LessonsService,
    ProgressService,
    LessonContentService,
    BunnyStreamService,
  ],
  exports: [LessonsService, ProgressService, BunnyStreamService, TypeOrmModule],
})
export class LessonsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Lesson services ready
  }
}
