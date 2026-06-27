import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminLessonsController,
  LessonsController,
  StudentLessonsController,
  TeacherLessonsController,
} from './controllers';
import { Lesson } from './entities/lesson.entity';
import { LessonProgress } from './entities/lesson-progress.entity';
import { LessonsService } from './lessons.service';
import { ProgressService } from './progress.service';

@Module({
  imports: [TypeOrmModule.forFeature([Lesson, LessonProgress, User, Subject])],
  controllers: [
    AdminLessonsController,
    LessonsController,
    StudentLessonsController,
    TeacherLessonsController,
  ],
  providers: [LessonsService, ProgressService],
  exports: [LessonsService, ProgressService, TypeOrmModule],
})
export class LessonsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Lesson services ready
  }
}
