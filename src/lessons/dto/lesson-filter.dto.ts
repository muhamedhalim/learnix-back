import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsInt,
  IsUUID,
  Min,
  Max,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class LessonFilterDto {
  @ApiProperty({
    description: 'Search by title',
    required: false,
    example: 'Algebra',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiProperty({
    description: 'Filter by teacher ID (UUID)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  @IsOptional()
  teacher_id?: string;

  @ApiProperty({
    description: 'Filter by subject ID (UUID)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  @IsOptional()
  subject_id?: string;

  @ApiProperty({
    description: 'Filter by group lessons',
    required: false,
    example: false,
  })
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  is_group?: boolean;

  @ApiProperty({
    description: 'Minimum price filter',
    required: false,
    example: 0,
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(0)
  minPrice?: number;

  @ApiProperty({
    description: 'Maximum price filter',
    required: false,
    example: 500,
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(0)
  maxPrice?: number;

  @ApiProperty({
    description: 'Sort by field',
    required: false,
    enum: ['price', 'title', 'created_at', 'students_count'],
    example: 'created_at',
  })
  @IsString()
  @IsOptional()
  sortBy?: 'price' | 'title' | 'created_at' | 'students_count';

  @ApiProperty({
    description: 'Sort order',
    required: false,
    enum: ['asc', 'desc'],
    example: 'desc',
  })
  @IsString()
  @IsOptional()
  order?: 'asc' | 'desc';

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
  page?: number = 1;

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
  limit?: number = 20;
}
