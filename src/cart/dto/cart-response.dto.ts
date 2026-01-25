import { ApiProperty } from '@nestjs/swagger';

import { CartItemType } from '../entities/cart-item.entity';

/**
 * Cart item details for response
 */
export class CartItemResponseDto {
  @ApiProperty({ description: 'Cart item ID' })
  public id!: string;

  @ApiProperty({
    description: 'Item type',
    enum: CartItemType,
  })
  public itemType!: CartItemType;

  @ApiProperty({ description: 'Item ID' })
  public itemId!: string;

  @ApiProperty({ description: 'Item title' })
  public itemTitle!: string;

  @ApiProperty({ description: 'Item price' })
  public price!: number;
}

/**
 * Complete cart response with items and totals
 */
export class CartResponseDto {
  @ApiProperty({ description: 'Cart ID' })
  public id!: string;

  @ApiProperty({
    description: 'Cart items',
    type: [CartItemResponseDto],
  })
  public items!: CartItemResponseDto[];

  @ApiProperty({ description: 'Subtotal (sum of item prices)' })
  public subtotal!: number;

  @ApiProperty({
    description: 'Applied discount code',
    nullable: true,
  })
  public discountCode!: string | null;

  @ApiProperty({ description: 'Discount amount' })
  public discountAmount!: number;

  @ApiProperty({ description: 'Total after discount' })
  public total!: number;
}
