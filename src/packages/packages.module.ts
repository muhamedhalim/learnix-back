import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { User } from '../users/entities/user.entity';
import { PackagesService } from './packages.service';
import {
  PackagesController,
  TeacherPackagesController,
  AdminPackagesController,
} from './controllers';

@Module({
  imports: [
    TypeOrmModule.forFeature([LessonPackage, LessonPackageItem, Lesson, User]),
  ],
  controllers: [
    PackagesController,
    TeacherPackagesController,
    AdminPackagesController,
  ],
  providers: [PackagesService],
  exports: [PackagesService, TypeOrmModule],
})
export class PackagesModule {}
