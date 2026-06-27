import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
} from 'class-validator';

import type { AttendanceStatus } from '../entities/attendance-record.entity';

export class AttendanceFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by student ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  public student_id?: string;

  @ApiPropertyOptional({
    description: 'Filter by lesson ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  public lesson_id?: string;

  @ApiPropertyOptional({
    description: 'Filter by attendance status',
    enum: ['present', 'absent', 'late', 'excused'],
  })
  @IsOptional()
  @IsEnum(['present', 'absent', 'late', 'excused'])
  public status?: AttendanceStatus;

  @ApiPropertyOptional({
    description: 'Filter from date (ISO format)',
    example: '2025-01-01',
  })
  @IsOptional()
  @IsDateString()
  public from_date?: string;

  @ApiPropertyOptional({
    description: 'Filter to date (ISO format)',
    example: '2025-12-31',
  })
  @IsOptional()
  @IsDateString()
  public to_date?: string;

  @ApiPropertyOptional({
    description: 'Page number',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  public page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  public limit?: number;
}
