import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsUUID,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

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
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by teacher ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID('4')
  teacher_id?: string;

  @ApiPropertyOptional({
    description: 'Minimum price filter',
    example: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minPrice?: number;

  @ApiPropertyOptional({
    description: 'Maximum price filter',
    example: 200,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Filter by active status',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as boolean | undefined;
  })
  is_active?: boolean;

  @ApiPropertyOptional({
    description: 'Sort by field',
    enum: PackageSortBy,
    default: PackageSortBy.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(PackageSortBy)
  sortBy?: PackageSortBy = PackageSortBy.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsString()
  order?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;
}
