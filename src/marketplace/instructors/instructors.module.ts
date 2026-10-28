import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../../activity-logs/activity-logs.module';
import { MarketplaceCourse } from '../catalog/entities';
import { MarketplaceCommonModule } from '../common/common.module';
import { ApprovedInstructorGuard } from '../common/guards/approved-instructor.guard';
import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceCourseReview } from '../reviews/entities';
import { User } from '../../users/entities/user.entity';
import { ApplicationDocumentsService } from './application-documents.service';
import { AdminApplicationsController } from './controllers/admin-applications.controller';
import { ApplicationsController } from './controllers/applications.controller';
import { InstructorProfileController } from './controllers/instructor-profile.controller';
import { InstructorUploadsController } from './controllers/instructor-uploads.controller';
import { PublicInstructorController } from './controllers/public-instructor.controller';
import { PublicApplicationsController } from './controllers/public-applications.controller';
import { InstructorApplication, MarketplaceInstructor } from './entities';
import { InstructorAccountService } from './instructor-account.service';
import { InstructorApplicationService } from './instructor-application.service';
import { InstructorProfileService } from './instructor-profile.service';
import { InstructorService } from './instructor.service';
import { PublicInstructorProfileService } from './public-instructor-profile.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InstructorApplication,
      MarketplaceInstructor,
      MarketplaceCourse,
      MarketplaceCourseReview,
      MarketplaceEnrollment,
      // Read/written only by `InstructorAccountService`, to provision the
      // platform identity behind an approved public application. The arrow
      // points marketplace → platform; nothing academic depends on this.
      User,
    ]),
    ActivityLogsModule,
    MarketplaceCommonModule,
  ],
  controllers: [
    ApplicationsController,
    PublicApplicationsController,
    AdminApplicationsController,
    PublicInstructorController,
    InstructorProfileController,
    InstructorUploadsController,
  ],
  providers: [
    ApprovedInstructorGuard,
    InstructorAccountService,
    InstructorApplicationService,
    InstructorService,
    InstructorProfileService,
    ApplicationDocumentsService,
    PublicInstructorProfileService,
  ],
  exports: [
    TypeOrmModule,
    ApprovedInstructorGuard,
    InstructorApplicationService,
    InstructorService,
    InstructorProfileService,
    ApplicationDocumentsService,
  ],
})
export class InstructorsModule {}
