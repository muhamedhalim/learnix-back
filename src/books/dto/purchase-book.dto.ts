import { IsInt, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class PurchaseBookDto {
  @ApiProperty({
    description: 'Book ID to purchase',
    example: 1,
  })
  @IsInt()
  @IsNotEmpty()
  @Type(() => Number)
  book_id!: number;

  @ApiPropertyOptional({
    description: 'Discount code to apply',
    example: 'SAVE20',
  })
  @IsString()
  @IsOptional()
  discount_code?: string;

  @ApiPropertyOptional({
    description: 'Purchase code for free access',
    example: 'FREE-BOOK-123',
  })
  @IsString()
  @IsOptional()
  purchase_code?: string;
}
