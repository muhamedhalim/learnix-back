import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

import { BillingDataDto } from './billing-data.dto';

/** Named distinctly from `books/dto/purchase-book.dto.ts` (a different shape,
 * used by the legacy `/student/books/purchase` stub) to avoid a Swagger
 * duplicate-schema-name collision. */
export class PurchaseBookPaymentDto {
  @ApiProperty({
    description: 'ID of the book to purchase (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  public book_id!: string;

  @ApiPropertyOptional({
    description: 'Discount code to apply',
    example: 'SAVE20',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  public discount_code?: string;

  @ApiPropertyOptional({
    description: 'Idempotency key for preventing duplicate purchases',
    example: 'purchase-123-1703001234567',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public idempotency_key?: string;

  @ApiProperty({
    description: 'Billing information for Paymob',
  })
  @ValidateNested()
  @Type(() => BillingDataDto)
  public billing_data!: BillingDataDto;
}
