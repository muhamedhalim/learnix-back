import { ApiPropertyOptional } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
import { ExamStatus } from '../entities';

/** Filter/paginate exams across all teachers (admin-only). */
export class AdminExamFilterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  public subject_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  public teacher_id?: string;

  @ApiPropertyOptional({ enum: ExamStatus })
  @IsOptional()
  @IsEnum(ExamStatus)
  public status?: ExamStatus;

  @ApiPropertyOptional({ description: 'ISO date — exams created on/after this date' })
  @IsOptional()
  @IsDateString()
  public date_from?: string;

  @ApiPropertyOptional({ description: 'ISO date — exams created on/before this date' })
  @IsOptional()
  @IsDateString()
  public date_to?: string;

  @ApiPropertyOptional({ enum: ['created_at', 'title', 'total_marks'] })
  @IsOptional()
  @IsIn(['created_at', 'title', 'total_marks'])
  public sort_by?: 'created_at' | 'title' | 'total_marks';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'] })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  public sort_order?: 'ASC' | 'DESC';

  @ApiPropertyOptional({
    description:
      'Add meta.status_counts (per-status totals under every other filter, status excluded)',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as boolean | undefined;
  })
  public include_status_counts?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;
}
