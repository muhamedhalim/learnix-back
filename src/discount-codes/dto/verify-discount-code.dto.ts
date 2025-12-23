import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, IsEnum, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApplicableItem } from '../entities/applicable-item.enum';

export class VerifyDiscountCodeDto {
  @ApiProperty({
    description: 'The discount code to verify',
    example: 'SAVE20',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({
    description: 'Type of item being purchased',
    enum: ApplicableItem,
    example: ApplicableItem.LESSON,
  })
  @IsEnum(ApplicableItem)
  item_type!: ApplicableItem;

  @ApiProperty({
    description: 'ID of the item being purchased',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  item_id!: number;

  @ApiProperty({
    description: 'Original price of the item (in EGP)',
    example: 100,
  })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount!: number;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
  discount_code_id?: number;
  discount_type?: string;
  discount_value?: number;
  discount_amount?: number;
  final_amount?: number;
}
