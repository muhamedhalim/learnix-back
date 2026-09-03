import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CertificatesModule } from '../../certificates/certificates.module';
import { LessonsModule } from '../../lessons/lessons.module';
import { User } from '../../users/entities/user.entity';
import { CatalogModule } from '../catalog/catalog.module';
import { CommerceModule } from '../commerce/commerce.module';
import { LearnerCertificatesController } from './controllers/learner-certificates.controller';
import { LearnerPlayerController } from './controllers/learner-player.controller';
import { MarketplaceCertificateIssuanceService } from './certificate-issuance.service';
import { CompletionService } from './completion.service';
import { LessonProgressService } from './lesson-progress.service';
import { PlayerService } from './player.service';
import { ProgressService } from './progress.service';

/**
 * FR-238 – FR-244, FR-248, FR-251, FR-324. `CommerceModule` supplies
 * `Repository<MarketplaceEnrollment>`/`Repository<MarketplaceLessonProgress>`,
 * `AccessService` and `EnrollmentService`; `CatalogModule` supplies
 * `Repository<MarketplaceCourseSection>`/`Repository<MarketplaceCourseLesson>`/
 * `Repository<MarketplaceCourse>`; `LessonsModule` supplies
 * `BunnyStreamService` — the same signing service the academic player
 * already uses, reused here rather than a second Bunny integration
 * (matching `LessonVideoService`'s own precedent); `CertificatesModule`
 * supplies `CertificatesService`'s subject-agnostic issuance/revocation
 * primitives, reused rather than a second certificates table.
 */
@Module({
  imports: [CommerceModule, CatalogModule, LessonsModule, CertificatesModule, TypeOrmModule.forFeature([User])],
  controllers: [LearnerPlayerController, LearnerCertificatesController],
  providers: [ProgressService, CompletionService, LessonProgressService, PlayerService, MarketplaceCertificateIssuanceService],
  exports: [ProgressService, CompletionService, LessonProgressService, PlayerService, MarketplaceCertificateIssuanceService],
})
export class LearningModule {}
