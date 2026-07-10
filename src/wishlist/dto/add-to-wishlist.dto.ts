import { IsEnum, IsUUID } from 'class-validator';

import { WishlistItemType } from '../entities/wishlist-item.entity';

/**
 * DTO for adding an item to the wishlist.
 */
export class AddToWishlistDto {
  @IsEnum(WishlistItemType)
  public itemType!: WishlistItemType;

  @IsUUID()
  public itemId!: string;
}
