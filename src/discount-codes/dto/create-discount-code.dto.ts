import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  IsArray,
  IsOptional,
  IsBoolean,
  IsDateString,
  Min,
  Max,
  MaxLength,
  MinLength,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DiscountType } from '../entities/discount-type.enum';
import { ApplicableItem } from '../entities/applicable-item.enum';

export class CreateDiscountCodeDto {
  @ApiProperty({
    description: 'Unique discount code',
    example: 'SAVE20',
    minLength: 3,
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(50)
  code!: string;

  @ApiProperty({
    description: 'Type of discount',
    enum: DiscountType,
    example: DiscountType.PERCENTAGE,
  })
  @IsEnum(DiscountType)
  discount_type!: DiscountType;

  @ApiProperty({
    description: 'Discount value (percentage or fixed amount in EGP)',
    example: 20,
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  @Max(100, {
    message: 'Percentage discount cannot exceed 100%',
  })
  @Type(() => Number)
  discount_value!: number;

  @ApiProperty({
    description: 'Item types this discount applies to',
    enum: ApplicableItem,
    isArray: true,
    example: [ApplicableItem.LESSON, ApplicableItem.PACKAGE],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ApplicableItem, { each: true })
  applicable_to!: ApplicableItem[];

  @ApiProperty({
    description: 'Specific item IDs (null for all items)',
    required: false,
    example: [1, 2, 3],
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  item_ids?: number[];

  @ApiProperty({
    description: 'Maximum number of times this code can be used',
    example: 100,
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  max_uses?: number;

  @ApiProperty({
    description: 'Minimum purchase amount required (in EGP)',
    example: 50,
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  min_purchase_amount?: number;

  @ApiProperty({
    description: 'Date when the discount becomes valid',
    example: '2025-01-01T00:00:00Z',
  })
  @IsDateString()
  valid_from!: string;

  @ApiProperty({
    description: 'Date when the discount expires',
    example: '2025-12-31T23:59:59Z',
  })
  @IsDateString()
  valid_until!: string;

  @ApiProperty({
    description: 'Whether the discount code is active',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiProperty({
    description: 'Description of the discount',
    required: false,
    example: 'Summer sale discount',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
