import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { AttendanceCodeType } from '../entities/attendance-code-type.enum';
import { CollectionParty } from '../../payments/entities/collection-party.enum';

/** Max codes a single batch may request. Larger runs should be split. */
export const MAX_BATCH_SIZE = 100_000;

export class CreateCodeBatchDto {
  @ApiProperty({ description: 'Human-readable batch name', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  public name!: string;

  @ApiProperty({ enum: AttendanceCodeType, description: 'Item type the codes unlock' })
  @IsEnum(AttendanceCodeType)
  public type!: AttendanceCodeType;

  @ApiProperty({ description: 'Target item ID (lesson/package/book UUID)' })
  @IsUUID('4')
  public item_id!: string;

  @ApiProperty({
    description: `Number of codes to generate (1–${MAX_BATCH_SIZE})`,
    minimum: 1,
    maximum: MAX_BATCH_SIZE,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BATCH_SIZE)
  public count!: number;

  @ApiProperty({ description: 'Expiry timestamp for all codes (ISO 8601)' })
  @IsDateString()
  public expires_at!: string;

  @ApiProperty({ enum: CollectionParty, description: 'Party that collects cash for these codes' })
  @IsEnum(CollectionParty)
  public collection_party!: CollectionParty;

  @ApiProperty({ required: false, description: 'Optional sale value snapshot in minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public face_value_minor?: number;

  @ApiProperty({
    required: false,
    description: 'Order-specific platform commission in basis points',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  public platform_commission_bps?: number;

  @ApiProperty({ required: false, description: 'Distribution and collection notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public distribution_notes?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  public export_allowed?: boolean;
}
