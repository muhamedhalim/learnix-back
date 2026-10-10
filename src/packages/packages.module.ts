import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BunnyStreamService } from '../lessons/bunny-stream.service';
import { LessonAwsVideoService } from '../lessons/lesson-aws-video.service';
import { UploadModule } from '../uploads/upload.module';
import { VideoModule } from '../video/video.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { CertificateTemplate } from '../certificates/entities/certificate-template.entity';
import { MetricsModule } from '../common/metrics';
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
import { CourseVersion } from './entities/course-version.entity';
import { CourseVersionItem } from './entities/course-version-item.entity';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';
import { PackagesService } from './packages.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LessonPackage,
      LessonPackageItem,
      CourseChapter,
      CourseVersion,
      CourseVersionItem,
      Lesson,
      User,
      TeacherProfile,
      PackagePurchase,
      Subject,
      CertificateTemplate,
    ]),
    MediaModule,
    MetricsModule,
    ReviewsModule,
    VideoModule,
    UploadModule,
  ],
  controllers: [
    AdminPackagesController,
    PackagesController,
    TeacherPackagesController,
  ],
  providers: [PackagesService, CoursePreviewService, BunnyStreamService, LessonAwsVideoService],
  exports: [PackagesService, TypeOrmModule],
})
export class PackagesModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Package services ready
  }
}
