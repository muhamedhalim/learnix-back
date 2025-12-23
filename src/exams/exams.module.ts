import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Exam } from './entities/exam.entity';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { User } from '../users/entities/user.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { ExamsService } from './exams.service';
import {
  ExamsController,
  TeacherExamsController,
  StudentExamsController,
} from './controllers';

@Module({
  imports: [TypeOrmModule.forFeature([Exam, ExamAttempt, User, Subject])],
  controllers: [
    ExamsController,
    TeacherExamsController,
    StudentExamsController,
  ],
  providers: [ExamsService],
  exports: [ExamsService, TypeOrmModule],
})
export class ExamsModule {}
