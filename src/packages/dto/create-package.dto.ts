import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { CourseStatus } from '../entities/course-status.enum';

export class CreatePackageDto {
  @MaxLength(255)
  public title!: string;

  @ApiProperty({ description: 'Subject this package belongs to' })
  @IsUUID()
  public subject_id!: string;

  @ApiPropertyOptional({
    description: 'Published certificate template used by default for this course',
  })
  @IsOptional()
  @IsUUID()
  public certificate_template_id?: string;

  @ApiPropertyOptional({
    description:
      'Arabic title (optional). Defaults to `title` when omitted so courses can be single-language.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title_ar?: string;

  // ── Course CMS fields (all optional) ───────────────────────────────────────
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
    description: 'Package description in English',
    example: 'A complete package covering all math topics for grade 10',
  })
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({
    description: 'Package description in Arabic',
    example: 'حزمة كاملة تغطي جميع موضوعات الرياضيات للصف العاشر',
  })
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiProperty({
    description: 'Package price (must be less than or equal to original_price)',
    example: 99.99,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  public price!: number;

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
