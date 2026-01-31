import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { AttendanceCodeType } from '../entities/attendance-code-type.enum';

export class GenerateAttendanceCodesDto {
  @IsEnum(AttendanceCodeType)
  public type!: AttendanceCodeType;

  @ApiProperty({
    description: 'ID of the item (lesson_id, package_id, or book_id)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  public item_id!: string;

  @ApiProperty({
    description: 'Number of codes to generate',
    example: 10,
    minimum: 1,
    maximum: 100,
  })
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  public count!: number;

  @IsDateString()
  public expires_at!: string;
}
