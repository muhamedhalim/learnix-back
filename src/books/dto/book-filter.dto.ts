import { IsOptional, IsString, IsInt, IsEnum, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class BookFilterDto {
  @ApiPropertyOptional({
    description: 'Search by title',
    example: 'Mathematics',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by subject ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  subject_id?: string;

  @ApiPropertyOptional({
    description: 'Filter by teacher ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  teacher_id?: string;

  @ApiPropertyOptional({
    description: 'Sort by field',
    enum: ['price', 'title', 'created_at', 'purchase_count'],
    default: 'created_at',
  })
  @IsOptional()
  @IsEnum(['price', 'title', 'created_at', 'purchase_count'])
  sortBy?: 'price' | 'title' | 'created_at' | 'purchase_count';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'Page number',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number;
}
