import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { Difficulty, QuestionType } from '../entities';

/** Search/filter/paginate the question bank (teacher-scoped). */
export class QuestionFilterDto {
  @ApiPropertyOptional({ description: 'Search prompt text (EN/AR) and tags' })
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
  public lesson_id?: string;

  @ApiPropertyOptional({ enum: QuestionType })
  @IsOptional()
  @IsEnum(QuestionType)
  public type?: QuestionType;

  @ApiPropertyOptional({ enum: Difficulty })
  @IsOptional()
  @IsEnum(Difficulty)
  public difficulty?: Difficulty;

  @ApiPropertyOptional({ description: 'Comma-free single tag to match' })
  @IsOptional()
  @IsString()
  public tag?: string;

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
