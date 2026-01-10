import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BillingDataDto } from './billing-data.dto';

export class PurchaseLessonDto {
  @ApiProperty({
    description: 'ID of the lesson to purchase (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4', { message: 'Lesson ID must be a valid UUID' })
  @IsNotEmpty()
  lesson_id!: string;

  @ApiPropertyOptional({
    description: 'Discount code to apply',
    example: 'SAVE20',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  discount_code?: string;

  @ApiPropertyOptional({
    description: 'Idempotency key for preventing duplicate purchases',
    example: 'purchase-123-1703001234567',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotency_key?: string;

  @ApiProperty({
    description: 'Billing information for Paymob',
  })
  @ValidateNested()
  @Type(() => BillingDataDto)
  billing_data!: BillingDataDto;
}
