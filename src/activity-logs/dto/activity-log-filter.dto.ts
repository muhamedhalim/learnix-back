import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

export class ActivityLogFilterDto {
  @ApiPropertyOptional({
    description: 'Start date for filtering (ISO 8601)',
    example: '2025-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  public from?: string;

  @ApiPropertyOptional({
    description: 'End date for filtering (ISO 8601)',
    example: '2025-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  public to?: string;

  @ApiPropertyOptional({
    description: 'Filter by action type',
    example: 'lesson_purchased',
  })
  @IsOptional()
  @IsString()
  public action?: string;

  @ApiPropertyOptional({
    description: 'Filter by resource type',
    example: 'lesson',
  })
  @IsOptional()
  @IsString()
  public resource_type?: string;

  @ApiPropertyOptional({
    description: 'Page number',
    default: 1,
  })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({
    description: 'Items per page (max 100)',
    default: 50,
  })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;
}

export class AuditLogFilterDto {
  @ApiPropertyOptional({
    description: 'Start date for filtering (ISO 8601)',
    example: '2025-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  public from?: string;

  @ApiPropertyOptional({
    description: 'End date for filtering (ISO 8601)',
    example: '2025-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  public to?: string;

  @ApiPropertyOptional({
    description: 'Filter by action type',
    example: 'user_approved',
  })
  @IsOptional()
  @IsString()
  public action?: string;

  @ApiPropertyOptional({
    description: 'Filter by target type',
    example: 'user',
  })
  @IsOptional()
  @IsString()
  public target_type?: string;

  @ApiPropertyOptional({
    description: 'Page number',
    default: 1,
  })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({
    description: 'Items per page (max 100)',
    default: 50,
  })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;
}
