import { ApiProperty } from '@nestjs/swagger';

import { WishlistItemType } from '../entities/wishlist-item.entity';

/**
 * A single resolved wishlist entry (favourite + denormalised item details).
 */
export class WishlistItemResponseDto {
  @ApiProperty({ description: 'Wishlist entry ID' })
  public id!: string;

  @ApiProperty({ description: 'Item type', enum: WishlistItemType })
  public itemType!: WishlistItemType;

  @ApiProperty({ description: 'Referenced lesson/package ID' })
  public itemId!: string;

  @ApiProperty({ description: 'Item title (or a placeholder if unavailable)' })
  public title!: string;

  @ApiProperty({ description: 'Item price' })
  public price!: number;

  @ApiProperty({ description: 'Raw stored cover image path', nullable: true })
  public thumbnail!: string | null;

  @ApiProperty({
    description: 'Whether the referenced item still exists / is purchasable',
  })
  public available!: boolean;

  @ApiProperty({ description: 'When the item was added to the wishlist' })
  public addedAt!: Date;
}

/**
 * Complete wishlist response with entries and total count.
 */
export class WishlistResponseDto {
  @ApiProperty({ description: 'Wishlist entries', type: [WishlistItemResponseDto] })
  public items!: WishlistItemResponseDto[];

  @ApiProperty({ description: 'Total number of entries (after filtering)' })
  public count!: number;
}

/**
 * A "most wishlisted" analytics row (admin).
 */
export class TopWishlistedItemDto {
  @ApiProperty({ enum: WishlistItemType })
  public itemType!: WishlistItemType;

  @ApiProperty()
  public itemId!: string;

  @ApiProperty()
  public title!: string;

  @ApiProperty({ description: 'How many users have wishlisted this item' })
  public wishlistCount!: number;
}
