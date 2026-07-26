import { ApiPropertyOptional } from '@nestjs/swagger';

import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { Pagination20Dto } from '../../common/dto/pagination.dto';

const HOMEWORK_STATUSES = ['draft', 'active', 'closed'] as const;
const HOMEWORK_SORTS = ['created_at', 'due_at', 'submission_count', 'average_score'] as const;
const HOMEWORK_SUBMISSION_FILTERS = ['graded', 'late', 'missing'] as const;
const SUBMISSION_STATUSES = ['not_submitted', 'submitted', 'graded'] as const;
const SUBMISSION_SORTS = ['submitted_at', 'student_name', 'score', 'late'] as const;

/** Teacher-scoped homework list. The authenticated user, never this DTO, selects the teacher. */
export class TeacherHomeworkFilterDto extends Pagination20Dto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  public lesson_id?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  public package_id?: string;

  @ApiPropertyOptional({ enum: HOMEWORK_STATUSES })
  @IsOptional()
  @IsIn(HOMEWORK_STATUSES)
  public status?: (typeof HOMEWORK_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  public needs_grading?: boolean;

  @ApiPropertyOptional({ enum: HOMEWORK_SUBMISSION_FILTERS })
  @IsOptional()
  @IsIn(HOMEWORK_SUBMISSION_FILTERS)
  public submission_filter?: (typeof HOMEWORK_SUBMISSION_FILTERS)[number];

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  public due_from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  public due_to?: string;

  @ApiPropertyOptional({ enum: HOMEWORK_SORTS, default: 'created_at' })
  @IsOptional()
  @IsIn(HOMEWORK_SORTS)
  public sort_by?: (typeof HOMEWORK_SORTS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  public order?: 'asc' | 'desc';
}

export class TeacherHomeworkSubmissionFilterDto extends Pagination20Dto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @ApiPropertyOptional({ enum: SUBMISSION_STATUSES })
  @IsOptional()
  @IsIn(SUBMISSION_STATUSES)
  public status?: (typeof SUBMISSION_STATUSES)[number];

  @ApiPropertyOptional({ description: 'true for late, false for on-time submissions' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  public late?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  public min_score?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  public max_score?: number;

  @ApiPropertyOptional({ enum: SUBMISSION_SORTS, default: 'submitted_at' })
  @IsOptional()
  @IsIn(SUBMISSION_SORTS)
  public sort_by?: (typeof SUBMISSION_SORTS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  public order?: 'asc' | 'desc';
}

/** Filters for aggregate reports. Limits prevent an unbounded student leaderboard response. */
export class TeacherHomeworkAnalyticsDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  public homework_id?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  public lesson_id?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  public package_id?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  public student_id?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  public from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  public to?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  public pass_threshold = 50;
}
