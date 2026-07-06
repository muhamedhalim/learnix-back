import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { ExamStatus } from '../entities';

/** Filter/paginate exams (teacher- or student-scoped depending on the caller). */
export class ExamFilterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  public subject_id?: string;

  @ApiPropertyOptional({ enum: ExamStatus })
  @IsOptional()
  @IsEnum(ExamStatus)
  public status?: ExamStatus;

  @ApiPropertyOptional({ enum: ['created_at', 'title', 'total_marks'] })
  @IsOptional()
  @IsIn(['created_at', 'title', 'total_marks'])
  public sort_by?: 'created_at' | 'title' | 'total_marks';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'] })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  public sort_order?: 'ASC' | 'DESC';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;
}
