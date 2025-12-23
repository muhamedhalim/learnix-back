import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeacherProfile } from './entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { TeachersService } from './teachers.service';
import {
  TeachersController,
  TeacherProfileController,
  AdminTeachersController,
} from './controllers';

@Module({
  imports: [TypeOrmModule.forFeature([TeacherProfile, User, Subject])],
  controllers: [
    TeachersController,
    TeacherProfileController,
    AdminTeachersController,
  ],
  providers: [TeachersService],
  exports: [TeachersService, TypeOrmModule],
})
export class TeachersModule {}
