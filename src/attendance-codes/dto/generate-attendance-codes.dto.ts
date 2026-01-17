import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsString,
  IsNumber,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AttendanceCodeType } from '../entities/attendance-code-type.enum';

export class GenerateAttendanceCodesDto {
  @ApiProperty({
    description: 'Type of item the codes will unlock',
    enum: AttendanceCodeType,
    example: AttendanceCodeType.LESSON,
  })
  @IsEnum(AttendanceCodeType)
  type!: AttendanceCodeType;

  @ApiProperty({
    description: 'ID of the item (lesson_id, package_id, or book_id)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  item_id!: string;

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
  count!: number;

  @ApiProperty({
    description: 'Expiration date for the codes',
    example: '2025-12-31T23:59:59Z',
  })
  @IsDateString()
  expires_at!: string;
}
