import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { AttendanceCodeType } from '../entities/attendance-code-type.enum';

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
}
