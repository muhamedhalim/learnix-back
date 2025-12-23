import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lesson } from './entities/lesson.entity';
import { User } from '../users/entities/user.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { LessonsService } from './lessons.service';
import {
  LessonsController,
  TeacherLessonsController,
  StudentLessonsController,
  AdminLessonsController,
} from './controllers';

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
export class LessonsModule {}
