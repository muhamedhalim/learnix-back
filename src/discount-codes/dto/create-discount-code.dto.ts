import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { ApplicableItem } from '../entities/applicable-item.enum';
import { DiscountType } from '../entities/discount-type.enum';

export class CreateDiscountCodeDto {
  @MaxLength(50)
  public code!: string;

  @IsEnum(DiscountType)
  public discount_type!: DiscountType;

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
  public discount_value!: number;

  @IsEnum(ApplicableItem, { each: true })
  public applicable_to!: ApplicableItem[];

  @ApiProperty({
    description: 'Specific item IDs (null for all items)',
    required: false,
    example: [1, 2, 3],
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  public item_ids?: string[];

  @ApiProperty({
    description: 'Maximum number of times this code can be used',
    example: 100,
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  public max_uses?: number;

  @ApiProperty({
    description: 'Minimum purchase amount required (in EGP)',
    example: 50,
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  public min_purchase_amount?: number;

  @IsDateString()
  public valid_from!: string;

  @IsDateString()
  public valid_until!: string;

  @ApiProperty({
    description: 'Whether the discount code is active',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  public is_active?: boolean;

  @ApiProperty({
    description: 'Description of the discount',
    required: false,
    example: 'Summer sale discount',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public description?: string;
}
