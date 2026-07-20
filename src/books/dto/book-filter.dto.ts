import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';

import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

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
  @StrictIntegerQuery()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @StrictIntegerQuery({ max: 100 })
  @Min(1)
  @Max(100)
  public limit?: number;
}

/** Teacher-scoped endpoints derive teacher_id from the authenticated session. */
export class TeacherBookFilterDto extends OmitType(BookFilterDto, [
  'teacher_id',
] as const) {}
