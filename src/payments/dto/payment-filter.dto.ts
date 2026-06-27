import { ApiProperty } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { ItemType } from '../entities/item-type.enum';
import { PaymentStatus } from '../entities/payment-status.enum';

export class PaymentFilterDto {
  @ApiProperty({
    description: 'Filter by payment status',
    required: false,
    enum: PaymentStatus,
    example: PaymentStatus.COMPLETED,
  })
  @IsEnum(PaymentStatus)
  @IsOptional()
  public status?: PaymentStatus;

  @ApiProperty({
    description: 'Filter by item type',
    required: false,
    enum: ItemType,
    example: ItemType.LESSON,
  })
  @IsEnum(ItemType)
  @IsOptional()
  public item_type?: ItemType;

  @ApiProperty({
    description: 'Filter by user ID (UUID)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  @IsOptional()
  public user_id?: string;

  @ApiProperty({
    description: 'Filter payments from this date',
    required: false,
    example: '2024-01-01',
  })
  @IsDateString()
  @IsOptional()
  public from_date?: string;

  @ApiProperty({
    description: 'Filter payments until this date',
    required: false,
    example: '2024-12-31',
  })
  @IsDateString()
  @IsOptional()
  public to_date?: string;

  @ApiProperty({
    description: 'Sort by field',
    required: false,
    enum: ['created_at', 'amount', 'final_amount', 'status'],
    example: 'created_at',
  })
  @IsString()
  @IsOptional()
  public sortBy?: 'created_at' | 'amount' | 'final_amount' | 'status';

  @ApiProperty({
    description: 'Sort order',
    required: false,
    enum: ['asc', 'desc'],
    example: 'desc',
  })
  @IsString()
  @IsOptional()
  public order?: 'asc' | 'desc';

  @ApiProperty({
    description: 'Page number',
    required: false,
    default: 1,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  public page?: number = 1;

  @ApiProperty({
    description: 'Items per page',
    required: false,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  public limit?: number = 20;
}
