import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

import { ApplicableItem } from '../entities/applicable-item.enum';

export class VerifyDiscountCodeDto {
  @IsNotEmpty()
  public code!: string;

  @IsEnum(ApplicableItem)
  public item_type!: ApplicableItem;

  @IsString()
  public item_id!: string;

  @ApiProperty({
    description: 'Original price of the item (in EGP)',
    example: 100,
  })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  public amount!: number;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
  discount_code_id?: string;
  discount_type?: string;
  discount_value?: number;
  discount_amount?: number;
  final_amount?: number;
}
