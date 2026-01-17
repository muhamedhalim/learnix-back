import { ApiProperty } from '@nestjs/swagger';
import { CartItemType } from '../entities/cart-item.entity';

/**
 * Cart item details for response
 */
export class CartItemResponseDto {
  @ApiProperty({ description: 'Cart item ID' })
  id!: string;

  @ApiProperty({
    description: 'Item type',
    enum: CartItemType,
  })
  itemType!: CartItemType;

  @ApiProperty({ description: 'Item ID' })
  itemId!: string;

  @ApiProperty({ description: 'Item title' })
  itemTitle!: string;

  @ApiProperty({ description: 'Item price' })
  price!: number;
}

/**
 * Complete cart response with items and totals
 */
export class CartResponseDto {
  @ApiProperty({ description: 'Cart ID' })
  id!: string;

  @ApiProperty({
    description: 'Cart items',
    type: [CartItemResponseDto],
  })
  items!: CartItemResponseDto[];

  @ApiProperty({ description: 'Subtotal (sum of item prices)' })
  subtotal!: number;

  @ApiProperty({
    description: 'Applied discount code',
    nullable: true,
  })
  discountCode!: string | null;

  @ApiProperty({ description: 'Discount amount' })
  discountAmount!: number;

  @ApiProperty({ description: 'Total after discount' })
  total!: number;
}
