import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsNotEmpty,IsOptional, IsString } from 'class-validator';

export class PurchaseBookDto {
  @IsNotEmpty()
  public book_id!: string;

  @ApiPropertyOptional({
    description: 'Discount code to apply',
    example: 'SAVE20',
  })
  @IsString()
  @IsOptional()
  public discount_code?: string;

  @ApiPropertyOptional({
    description: 'Purchase code for free access',
    example: 'FREE-BOOK-123',
  })
  @IsString()
  @IsOptional()
  public purchase_code?: string;
}
