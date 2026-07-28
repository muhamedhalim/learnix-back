import { ApiProperty } from '@nestjs/swagger';

import { Type, Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { ApplicableItem } from '../entities/applicable-item.enum';
import { DiscountType } from '../entities/discount-type.enum';

export class CreateDiscountCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  public code!: string;

  @IsEnum(DiscountType)
  public discount_type!: DiscountType;

  @ApiProperty({
    description: 'Percentage (1-100) or fixed EGP amount, depending on discount_type',
    example: 20,
    minimum: 0.01,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Type(() => Number)
  public discount_value!: number;

  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(ApplicableItem, { each: true })
  public applicable_to!: ApplicableItem[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  public item_ids?: string[];

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  public max_uses?: number;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  public max_uses_per_user?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  public min_purchase_amount?: number;

  @ApiProperty({
    description: 'Maximum monetary discount for a percentage code, in EGP',
    required: false,
    example: 100,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Type(() => Number)
  public max_discount_amount?: number;

  @IsOptional()
  @IsDateString()
  public valid_from?: string;

  @IsOptional()
  @IsDateString()
  public valid_until?: string | null;

  @IsOptional()
  @IsBoolean()
  public is_active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  public description?: string;
}
