import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../../activity-logs/activity-logs.module';
import { LessonsModule } from '../../lessons/lessons.module';
import { UploadModule } from '../../uploads/upload.module';
import { VideoModule } from '../../video/video.module';
import { MarketplaceEnrollment } from '../commerce/entities';
import { InstructorsModule } from '../instructors/instructors.module';
import { CategoryService } from './category.service';
import { AdminCategoriesController } from './controllers/admin-categories.controller';
import { AdminCoursesController } from './controllers/admin-courses.controller';
import { InstructorCoursesController } from './controllers/instructor-courses.controller';
import { InstructorCurriculumController } from './controllers/instructor-curriculum.controller';
import { CourseAuthoringService } from './course-authoring.service';
import { CourseEditClassifierService } from './course-edit-classifier.service';
import { CourseLifecycleService } from './course-lifecycle.service';
import { CourseReadinessService } from './course-readiness.service';
import { CourseVersionService } from './course-version.service';
import { LessonVideoService } from './lesson-video.service';
import {
  MarketplaceCategory,
  MarketplaceCourse,
  MarketplaceCourseLesson,
  MarketplaceCourseRemoval,
  MarketplaceCourseReviewDecision,
  MarketplaceCourseSection,
  MarketplaceCourseVersion,
} from './entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketplaceCategory,
      MarketplaceCourse,
      MarketplaceCourseSection,
      MarketplaceCourseLesson,
      MarketplaceCourseVersion,
      MarketplaceCourseRemoval,
      MarketplaceCourseReviewDecision,
      MarketplaceEnrollment,
    ]),
    // FR-051: lesson video upload and status go through VideoModule (S3, MediaConvert, CloudFront). One-way dependency only —
    // LessonsModule has no knowledge of marketplace code.
    LessonsModule,
    VideoModule,
    UploadModule,
    ActivityLogsModule,
    // `ApprovedInstructorGuard` (used by every controller in this module via
    // `@ApprovedInstructor()`) is provided and exported by InstructorsModule
    // — a sibling under MarketplaceModule does not share its DI container.
    InstructorsModule,
  ],
  controllers: [
    AdminCategoriesController,
    AdminCoursesController,
    InstructorCoursesController,
    InstructorCurriculumController,
  ],
  providers: [
    CategoryService,
    CourseAuthoringService,
    CourseReadinessService,
    CourseLifecycleService,
    CourseVersionService,
    CourseEditClassifierService,
    LessonVideoService,
  ],
  exports: [
    TypeOrmModule,
    CategoryService,
    CourseAuthoringService,
    CourseReadinessService,
    CourseLifecycleService,
    CourseVersionService,
    CourseEditClassifierService,
    LessonVideoService,
  ],
})
export class CatalogModule {}
