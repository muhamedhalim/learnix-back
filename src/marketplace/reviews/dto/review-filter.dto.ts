import { IsEnum, IsIn, IsOptional } from 'class-validator';

import { MarketplaceListQueryDto } from '../../common/dto/marketplace-pagination.dto';
import { CourseReviewStatus } from '../../common/enums';

/** FR-264 — recency (default) or rating, both descending. */
export type ReviewSort = 'recent' | 'rating';

export class ReviewFilterDto extends MarketplaceListQueryDto {
  @IsOptional()
  @IsIn(['recent', 'rating'])
  public sort?: ReviewSort;
}

/** T214 — the admin moderation queue's page size is validated the same as every other marketplace list, not left to raw unchecked query params. */
export class AdminReviewQueueQueryDto extends MarketplaceListQueryDto {
  @IsOptional()
  @IsEnum(CourseReviewStatus)
  public status?: CourseReviewStatus;
}
