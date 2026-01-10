import { IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PurchaseBookDto {
  @ApiProperty({
    description: 'Book ID to purchase',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsNotEmpty()
  book_id!: string;

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
