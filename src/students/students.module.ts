import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentProfile } from './entities/student-profile.entity';
import { User } from '../users/entities/user.entity';
import { StudentsService } from './students.service';
import {
  StudentsController,
  StudentProfileController,
  AdminStudentsController,
} from './controllers';

@Module({
  imports: [TypeOrmModule.forFeature([StudentProfile, User])],
  controllers: [
    StudentsController,
    StudentProfileController,
    AdminStudentsController,
  ],
  providers: [StudentsService],
  exports: [StudentsService, TypeOrmModule],
})
export class StudentsModule {}
