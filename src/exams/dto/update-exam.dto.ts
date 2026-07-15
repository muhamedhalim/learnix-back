import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsInt,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ExamConfigDto } from './exam-config.dto';

/** Update exam metadata / config. Only permitted while the exam is a DRAFT. */
export class UpdateExamDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title_ar?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  public subject_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  public lesson_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public is_public?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  public passing_marks?: number;

  @ApiPropertyOptional({ type: ExamConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExamConfigDto)
  public config?: ExamConfigDto;
}
