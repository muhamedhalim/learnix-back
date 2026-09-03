import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';

import { bi } from '../../../i18n/error-translator.util';
import { LessonContentType } from '../../common/enums';

/**
 * FR-046: every lesson — including text-only and non-timed lessons —
 * carries a positive duration; there is no default. `section_id` is
 * required here (not a URL param) because contracts §3 nests
 * `POST .../courses/:id/lessons` flat under the course, not under a
 * section.
 */
export class CreateLessonDto {
  @IsUUID('4')
  section_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title_ar?: string;

  @IsEnum(LessonContentType)
  content_type!: LessonContentType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  video_id?: string;

  /** Sanitised with `SanitizationService.sanitizeBasic` before persisting. */
  @IsOptional()
  @IsString()
  content_html?: string;

  @IsInt()
  @Min(1, { message: bi('duration_seconds must be a positive number', 'يجب أن تكون مدة الدرس رقمًا موجبًا') })
  duration_seconds!: number;

  @IsOptional()
  @IsBoolean()
  is_free_preview?: boolean;

  /** FR-242 — required by default; a free-preview lesson defaults to optional unless explicitly overridden here. */
  @IsOptional()
  @IsBoolean()
  is_required_for_completion?: boolean;
}

export class UpdateLessonDto {
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
  @IsEnum(LessonContentType)
  content_type?: LessonContentType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  video_id?: string;

  @IsOptional()
  @IsString()
  content_html?: string;

  @IsOptional()
  @IsInt()
  @Min(1, { message: bi('duration_seconds must be a positive number', 'يجب أن تكون مدة الدرس رقمًا موجبًا') })
  duration_seconds?: number;

  @IsOptional()
  @IsBoolean()
  is_free_preview?: boolean;

  @IsOptional()
  @IsBoolean()
  is_required_for_completion?: boolean;
}
