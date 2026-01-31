import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';

import {
  AdminTeachersController,
  TeacherProfileController,
  TeachersController,
} from './controllers';
import { TeacherProfile } from './entities/teacher-profile.entity';
import { TeachersService } from './teachers.service';

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
export class TeachersModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Teacher services ready
  }
}
