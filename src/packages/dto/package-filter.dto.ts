import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';

import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { CourseStatus } from '../entities/course-status.enum';
import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

export enum PackageSortBy {
  PRICE = 'price',
  TITLE = 'title',
  CREATED_AT = 'created_at',
  LESSONS_COUNT = 'lessons_count',
}

export class PackageFilterDto {
  @ApiPropertyOptional({
    description: 'Search by title (English or Arabic)',
    example: 'Math',
  })
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional({
    description: 'Filter by teacher ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID('4')
  public teacher_id?: string;

  @ApiPropertyOptional({
    description: 'Minimum price filter',
    example: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  public minPrice?: number;

  @ApiPropertyOptional({
    description: 'Maximum price filter',
    example: 200,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  public maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Filter by active status',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value as boolean | undefined;
  })
  public is_active?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by publishing status',
    enum: CourseStatus,
  })
  @IsOptional()
  @IsEnum(CourseStatus)
  public status?: CourseStatus;

  @ApiPropertyOptional({
    description: 'Sort by field',
    enum: PackageSortBy,
    default: PackageSortBy.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(PackageSortBy)
  public sortBy?: PackageSortBy = PackageSortBy.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsString()
  public order?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number = 20;
}

/** Teacher-scoped endpoints derive teacher_id from auth or a validated path. */
export class TeacherPackageFilterDto extends OmitType(PackageFilterDto, [
  'teacher_id',
] as const) {}
