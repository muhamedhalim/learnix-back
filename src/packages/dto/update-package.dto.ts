import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { CourseStatus } from '../entities/course-status.enum';

export class UpdatePackageDto {
  @ApiPropertyOptional({ enum: CourseStatus, description: 'Publishing state' })
  @IsOptional()
  @IsEnum(CourseStatus)
  public status?: CourseStatus;

  @ApiPropertyOptional({ description: 'Feature this course' })
  @IsOptional()
  @IsBoolean()
  public featured?: boolean;

  @ApiPropertyOptional({ description: 'Free-form category', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public category?: string;

  @ApiPropertyOptional({ description: 'Tags', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public tags?: string[];

  @ApiPropertyOptional({ description: 'Estimated duration in minutes', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  public estimated_duration?: number;

  @ApiPropertyOptional({
    description: 'Auto-publish this draft at the given time (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  public scheduled_publish_at?: string;
  @ApiPropertyOptional({
    description: 'Package title in English',
    example: 'Complete Math Package',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title?: string;

  @ApiPropertyOptional({
    description: 'Package title in Arabic',
    example: 'حزمة الرياضيات الكاملة',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title_ar?: string;

  @ApiPropertyOptional({
    description: 'Package description in English',
    example: 'A complete package covering all math topics',
  })
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({
    description: 'Package description in Arabic',
    example: 'حزمة كاملة تغطي جميع موضوعات الرياضيات',
  })
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiPropertyOptional({
    description: 'Package price',
    example: 99.99,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  public price?: number;

  @ApiPropertyOptional({
    description: 'Whether the package is active and available for purchase',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  public is_active?: boolean;

  @ApiPropertyOptional({
    description:
      'Storage key from /teacher/uploads/image (preferred), or a full external image URL.',
    example: 'images/9c1b7e2a-....jpg',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public thumbnail?: string;
}
