import { IsEnum, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CartItemType } from '../entities/cart-item.entity';

/**
 * DTO for adding an item to cart
 */
export class AddToCartDto {
  @ApiProperty({
    description: 'Type of item to add',
    enum: CartItemType,
    example: CartItemType.LESSON,
  })
  @IsEnum(CartItemType)
  itemType!: CartItemType;

  @ApiProperty({
    description: 'ID of the item to add',
    example: 'e3b0c442-98fc-1c14-b39f-92d1282a4d8c',
  })
  @IsUUID()
  itemId!: string;
}
