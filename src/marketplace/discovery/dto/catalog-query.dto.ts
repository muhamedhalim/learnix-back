import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { CourseLevel } from '../../common/enums';
import type { CatalogSort } from '../catalog-query.service';

/**
 * Query strings arrive as text, and `@Type(() => Boolean)` turns every non-empty string, including
 * "false" and "0", into `true` (MP-22). Anything that is not clearly true/false is passed through so
 * `@IsBoolean` rejects it with a 400.
 */
export function parseQueryBoolean({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return value;
}

const SORTS: CatalogSort[] = ['newest', 'popular', 'rating', 'price_asc', 'price_desc'];

/** Contracts §1 `GET /marketplace/courses` query (FR-076 – FR-081). */
export class CatalogQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @IsOptional()
  @IsEnum(CourseLevel)
  level?: CourseLevel;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceMinor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceMinor?: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  freeOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  minRating?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minDurationSeconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDurationSeconds?: number;

  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  certificateOnly?: boolean;

  @IsOptional()
  @IsIn(SORTS)
  sort?: CatalogSort;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
