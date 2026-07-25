import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BunnyStreamService } from '../lessons/bunny-stream.service';
import { Lesson } from '../lessons/entities/lesson.entity';
import { MediaModule } from '../media/media.module';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { ReviewsModule } from '../reviews/reviews.module';
import { Subject } from '../subjects/entities/subject.entity';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminPackagesController,
  PackagesController,
  TeacherPackagesController,
} from './controllers';
import { CoursePreviewService } from './course-preview.service';
import { CourseChapter } from './entities/course-chapter.entity';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';
import { PackagesService } from './packages.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LessonPackage,
      LessonPackageItem,
      CourseChapter,
      Lesson,
      User,
      TeacherProfile,
      PackagePurchase,
      Subject,
    ]),
    MediaModule,
    ReviewsModule,
  ],
  controllers: [
    AdminPackagesController,
    PackagesController,
    TeacherPackagesController,
  ],
  providers: [PackagesService, CoursePreviewService, BunnyStreamService],
  exports: [PackagesService, TypeOrmModule],
})
export class PackagesModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Package services ready
  }
}
