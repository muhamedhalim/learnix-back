import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LessonsModule } from '../../lessons/lessons.module';
import { MarketplaceCategory, MarketplaceCourse } from '../catalog/entities';
import { CatalogModule } from '../catalog/catalog.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { CategoriesReadService } from './categories-read.service';
import { CatalogQueryService } from './catalog-query.service';
import { CatalogSearchService } from './catalog-search.service';
import { PublicCatalogController } from './controllers/public-catalog.controller';
import { PublicCategoriesController } from './controllers/public-categories.controller';
import { CourseDetailService } from './course-detail.service';
import { PreviewAccessService } from './preview-access.service';

/**
 * Public, unauthenticated read surfaces over catalog data (plan.md's
 * catalog/discovery split — catalog owns entities and instructor-authoring
 * writes, discovery owns public reads). `CatalogModule` gives this
 * `CourseVersionService` (immutable snapshots, FR-074/075) and, via its own
 * exported `TypeOrmModule`, every catalog + `MarketplaceEnrollment`
 * repository; `ReviewsModule` gives the review repository for rating
 * aggregates; `LessonsModule` gives `BunnyStreamService` for signed preview
 * playback (FR-048) — the same reuse `CatalogModule` itself already
 * establishes, never a second integration.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplaceCategory, MarketplaceCourse]),
    CatalogModule,
    ReviewsModule,
    LessonsModule,
  ],
  controllers: [PublicCategoriesController, PublicCatalogController],
  providers: [CategoriesReadService, CatalogQueryService, CatalogSearchService, CourseDetailService, PreviewAccessService],
  // `MarketplaceOrderService` (CommerceModule) reuses `baseVisibleQuery()` for
  // FR-103's published-course purchase gate rather than re-deriving it.
  exports: [CatalogQueryService],
})
export class DiscoveryModule {}
