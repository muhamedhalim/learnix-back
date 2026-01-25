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
import { LessonsService } from './lessons.service';

@Module({
  imports: [TypeOrmModule.forFeature([Lesson, User, Subject])],
  controllers: [
    LessonsController,
    TeacherLessonsController,
    StudentLessonsController,
    AdminLessonsController,
  ],
  providers: [LessonsService],
  exports: [LessonsService, TypeOrmModule],
})
export class LessonsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Lesson services ready
  }
}
