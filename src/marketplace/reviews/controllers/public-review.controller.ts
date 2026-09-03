import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ReviewFilterDto } from '../dto/review-filter.dto';
import { MarketplaceReviewService, PublicReviewList } from '../review.service';

/** Contracts §1: `GET /marketplace/courses/:slug/reviews` (FR-264). Mounted at the same base path as `PublicCatalogController`, in its own controller — the same nesting pattern `GET /marketplace/courses/:slug/preview/:lessonId` already uses. */
@ApiTags('Marketplace / Public Reviews')
@Controller('marketplace/courses')
export class PublicReviewController {
  constructor(private readonly reviews: MarketplaceReviewService) {}

  @Get(':slug/reviews')
  @ApiOperation({ summary: 'Visible reviews for a course, paginated and sortable by recency or rating (FR-264)' })
  public async list(@Param('slug') slug: string, @Query() query: ReviewFilterDto): Promise<PublicReviewList> {
    return this.reviews.listPublicReviews(slug, query.page, query.limit, query.sort);
  }
}
