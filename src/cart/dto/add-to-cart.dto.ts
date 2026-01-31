import { IsEnum, IsUUID } from 'class-validator';

import { CartItemType } from '../entities/cart-item.entity';

/**
 * DTO for adding an item to cart
 */
export class AddToCartDto {
  @IsEnum(CartItemType)
  public itemType!: CartItemType;

  @IsUUID()
  public itemId!: string;
}
