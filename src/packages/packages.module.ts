import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { User } from '../users/entities/user.entity';

import {
  AdminPackagesController,
  PackagesController,
  TeacherPackagesController,
} from './controllers';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';
import { PackagesService } from './packages.service';

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
export class PackagesModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Package services ready
  }
}
