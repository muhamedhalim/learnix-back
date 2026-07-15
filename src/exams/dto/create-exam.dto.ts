import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

/** Create an exam shell (metadata + config). Questions are attached separately. */
export class CreateExamDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  public title!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  public title_ar!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiProperty({ description: 'Subject UUID' })
  @IsUUID('4')
  public subject_id!: string;

  @ApiPropertyOptional({ description: 'Lesson UUID (access gating + analytics)' })
  @IsOptional()
  @IsUUID('4')
  public lesson_id?: string;

  @ApiPropertyOptional({ description: 'Explicit opt-in for a public quiz surface', default: false })
  @IsOptional()
  @IsBoolean()
  public is_public?: boolean;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  public passing_marks!: number;

  @ApiPropertyOptional({ type: ExamConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExamConfigDto)
  public config?: ExamConfigDto;
}
