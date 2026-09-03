import { IsIn, IsOptional } from 'class-validator';

import { MarketplaceListQueryDto } from '../../common/dto/marketplace-pagination.dto';

/** FR-264 — recency (default) or rating, both descending. */
export type ReviewSort = 'recent' | 'rating';

export class ReviewFilterDto extends MarketplaceListQueryDto {
  @IsOptional()
  @IsIn(['recent', 'rating'])
  public sort?: ReviewSort;
}
