import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketplaceCourse } from '../catalog/entities';
import { MarketplaceEnrollment } from '../commerce/entities';
import { InstructorsModule } from '../instructors/instructors.module';
import { AdminReviewController } from './controllers/admin-review.controller';
import { InstructorReviewController } from './controllers/instructor-review.controller';
import { LearnerReviewController } from './controllers/learner-review.controller';
import { PublicReviewController } from './controllers/public-review.controller';
import { ReviewReportController } from './controllers/review-report.controller';
import { MarketplaceCourseReview, MarketplaceReviewReport } from './entities';
import { ReviewAggregateService } from './review-aggregate.service';
import { ReviewModerationService } from './review-moderation.service';
import { ReviewReplyService } from './review-reply.service';
import { ReviewWithdrawalListener } from './review-withdrawal.listener';
import { MarketplaceReviewService } from './review.service';

/**
 * FR-253 – FR-266 (T148 – T155). `MarketplaceCourse` and
 * `MarketplaceEnrollment` are re-registered directly in this module's own
 * `TypeOrmModule.forFeature` — the same "entity registered in more than
 * one module" pattern `InstructorsModule` already uses for these same two
 * entities — rather than importing `CatalogModule`/`CommerceModule`
 * directly: `DiscoveryModule` already imports *this* module for the
 * review repository (built ahead of time in Phase 5, for the public
 * course-detail/listing aggregates), and `CommerceModule` imports
 * `DiscoveryModule`, so `ReviewsModule → CommerceModule` would close a
 * real cycle. `InstructorsModule` is safe to import directly (its own
 * imports are just `ActivityLogsModule`/`MarketplaceCommonModule`, neither
 * of which reaches back here).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplaceCourseReview, MarketplaceReviewReport, MarketplaceCourse, MarketplaceEnrollment]),
    InstructorsModule,
  ],
  controllers: [
    LearnerReviewController,
    ReviewReportController,
    PublicReviewController,
    InstructorReviewController,
    AdminReviewController,
  ],
  providers: [MarketplaceReviewService, ReviewAggregateService, ReviewReplyService, ReviewModerationService, ReviewWithdrawalListener],
  exports: [TypeOrmModule, MarketplaceReviewService, ReviewAggregateService, ReviewReplyService, ReviewModerationService],
})
export class ReviewsModule {}
