import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';

export class BookFilterDto {
  @ApiPropertyOptional({
    description: 'Search by title',
    example: 'Mathematics',
  })
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional({
    description: 'Filter by subject ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  public subject_id?: string;

  @ApiPropertyOptional({
    description: 'Filter by teacher ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  public teacher_id?: string;

  @ApiPropertyOptional({
    description: 'Sort by field',
    enum: ['price', 'title', 'created_at', 'purchase_count'],
    default: 'created_at',
  })
  @IsOptional()
  @IsEnum(['price', 'title', 'created_at', 'purchase_count'])
  public sortBy?: 'price' | 'title' | 'created_at' | 'purchase_count';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  public order?: 'asc' | 'desc';

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
