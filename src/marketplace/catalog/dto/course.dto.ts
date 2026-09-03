import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { bi } from '../../../i18n/error-translator.util';
import { CourseLevel } from '../../common/enums';

/** FR-042 – FR-044, FR-050. Every field optional so PATCH can send a partial payload; `create` requires the FR-042 minimum via the DTO below. */
export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title_ar?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  summary!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary_ar?: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsString()
  description_ar?: string;

  @IsUUID('4')
  category_id!: string;

  @IsEnum(CourseLevel)
  level!: CourseLevel;

  /** FR-044 — a fixed set that at minimum includes English and Arabic; not further restricted here. */
  @IsString()
  @MaxLength(10)
  language!: string;

  /** Minor units — `0` is valid (a free course). No default: the instructor states the currency explicitly (contracts/README.md gotcha this session's own money invariants rely on). */
  @IsInt()
  @Min(0, { message: bi('price_minor cannot be negative', 'لا يمكن أن يكون السعر سالبًا') })
  price_minor!: number;

  @IsString()
  @MaxLength(3)
  currency!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  cover_image_key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  promo_video_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  learning_outcomes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  prerequisites?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  target_audience?: string[];

  @IsOptional()
  @IsBoolean()
  certificate_enabled?: boolean;
}

export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title_ar?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary_ar?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @IsOptional()
  @IsString()
  description_ar?: string;

  @IsOptional()
  @IsUUID('4')
  category_id?: string;

  @IsOptional()
  @IsEnum(CourseLevel)
  level?: CourseLevel;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  price_minor?: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  cover_image_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  promo_video_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  learning_outcomes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  prerequisites?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  target_audience?: string[];

  @IsOptional()
  @IsBoolean()
  certificate_enabled?: boolean;
}

export class CreateSectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title_ar?: string;
}

export class UpdateSectionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title_ar?: string;
}

export class ReorderDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  @Type(() => String)
  ordered_ids!: string[];
}

/** Lessons are flat under the course (contracts §3), so a lesson reorder must name which section it applies to. */
export class ReorderLessonsDto extends ReorderDto {
  @IsUUID('4')
  section_id!: string;
}
