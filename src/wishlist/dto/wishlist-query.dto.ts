import { IsEnum, IsOptional } from 'class-validator';

import { WishlistItemType } from '../entities/wishlist-item.entity';

/**
 * Sort options for the wishlist listing.
 */
export enum WishlistSort {
  RECENT = 'recent',
  OLDEST = 'oldest',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
  TITLE = 'title',
}

/**
 * Query params for filtering / sorting the wishlist.
 */
export class WishlistQueryDto {
  /** Filter to a single item type (lesson | package). */
  @IsOptional()
  @IsEnum(WishlistItemType)
  public itemType?: WishlistItemType;

  /** Sort order (default: most recently added first). */
  @IsOptional()
  @IsEnum(WishlistSort)
  public sort?: WishlistSort;
}
