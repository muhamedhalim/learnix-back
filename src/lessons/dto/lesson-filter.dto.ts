import { ApiProperty, OmitType } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
import { StrictBooleanQuery } from '../../common/decorators/strict-boolean-query.decorator';

export class LessonFilterDto {
  @ApiProperty({
    description: 'Search by title',
    required: false,
    example: 'Algebra',
  })
  @IsString()
  @IsOptional()
  public search?: string;

  @ApiProperty({
    description: 'Filter by teacher ID (UUID)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  @IsOptional()
  public teacher_id?: string;

  @ApiProperty({
    description: 'Filter by subject ID (UUID)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  @IsOptional()
  public subject_id?: string;

  @ApiProperty({
    description: 'Filter by group lessons',
    required: false,
    example: false,
  })
  @StrictBooleanQuery()
  public is_group?: boolean;

  @ApiProperty({
    description:
      'Filter to lessons with at least one (or, when false, exactly zero) currently-bookable appointment slot. Meaningless for group lessons, which never have appointment slots.',
    required: false,
    example: true,
  })
  @StrictBooleanQuery()
  public has_available_sessions?: boolean;

  @ApiProperty({
    description: 'Minimum price filter',
    required: false,
    example: 0,
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(0)
  public minPrice?: number;

  @ApiProperty({
    description: 'Maximum price filter',
    required: false,
    example: 500,
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(0)
  public maxPrice?: number;

  @ApiProperty({
    description: 'Sort by field',
    required: false,
    enum: ['price', 'title', 'created_at', 'students_count'],
    example: 'created_at',
  })
  @IsString()
  @IsOptional()
  public sortBy?: 'price' | 'title' | 'created_at' | 'students_count';

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
  @StrictIntegerQuery()
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
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  public limit?: number = 20;
}

/** Teacher-scoped endpoints derive teacher_id from the authenticated session. */
export class TeacherLessonFilterDto extends OmitType(LessonFilterDto, [
  'teacher_id',
] as const) {}
