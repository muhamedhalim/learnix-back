import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, Min } from 'class-validator';

import { ReviewPolicy } from '../entities';

/**
 * Partial exam configuration. All fields are optional; the authoring service
 * merges the provided values over {@link DEFAULT_EXAM_CONFIG}.
 */
export class ExamConfigDto {
  @ApiPropertyOptional({ minimum: 30, description: 'Attempt duration in seconds' })
  @IsOptional()
  @IsInt()
  @Min(30)
  public duration_seconds?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  public attempts_allowed?: number;

  @ApiPropertyOptional({ description: 'ISO datetime the exam opens' })
  @IsOptional()
  @IsDateString()
  public start_window_at?: string;

  @ApiPropertyOptional({ description: 'ISO datetime the exam closes' })
  @IsOptional()
  @IsDateString()
  public end_window_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public shuffle_questions?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public shuffle_choices?: boolean;

  @ApiPropertyOptional({ enum: ReviewPolicy })
  @IsOptional()
  @IsEnum(ReviewPolicy)
  public review_policy?: ReviewPolicy;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public negative_marking?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public show_score_immediately?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  public grace_seconds?: number;
}

/** Schedule-only update allowed after an exam has been published. */
export class RescheduleExamDto {
  @ApiPropertyOptional({
    description: 'ISO datetime the exam opens; null clears it',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  public start_window_at?: string | null;

  @ApiPropertyOptional({
    description: 'ISO datetime the exam closes; null clears it',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  public end_window_at?: string | null;
}
