import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { HomeworkQuestionDto } from './homework.dto';

export class CreateAttachmentDto {
  @ApiProperty({ description: 'Display name', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public name!: string;

  @ApiPropertyOptional({ description: 'Display name (Arabic)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public name_ar?: string;

  @ApiProperty({ description: 'Public file URL (from /teacher/uploads)', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public url!: string;

  @ApiPropertyOptional({ description: 'pdf | docx | zip | image | pptx | audio | other' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  public type?: string;

  @ApiPropertyOptional({ description: 'Size in bytes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  public size_bytes?: number;
}

export class CreateHomeworkDto {
  @ApiProperty({ description: 'Assignment title', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public title!: string;

  @ApiPropertyOptional({ description: 'Assignment title (Arabic)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title_ar?: string;

  @ApiPropertyOptional({ description: 'Instructions / description' })
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({ description: 'Instructions / description (Arabic)' })
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiPropertyOptional({ description: 'Assignment type (text | file | link | …)' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  public type?: string;

  @ApiPropertyOptional({ description: 'Optional resource URL', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public resource_url?: string;

  @ApiPropertyOptional({ description: 'Original uploaded filename (display only)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public resource_filename?: string;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public due_at?: string;

  @ApiPropertyOptional({
    type: [HomeworkQuestionDto],
    description: 'Structured assignment questions',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HomeworkQuestionDto)
  public questions?: HomeworkQuestionDto[];

  @ApiPropertyOptional({ default: 100, minimum: 0.01 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  public max_score?: number;
}

export class UpdateHomeworkDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title?: string;

  @ApiPropertyOptional({ description: 'Assignment title (Arabic)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title_ar?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({ description: 'Instructions / description (Arabic)' })
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  public type?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public resource_url?: string;

  @ApiPropertyOptional({ description: 'Original uploaded filename (display only)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public resource_filename?: string;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public due_at?: string;

  @ApiPropertyOptional({ type: [HomeworkQuestionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HomeworkQuestionDto)
  public questions?: HomeworkQuestionDto[];

  @ApiPropertyOptional({ minimum: 0.01 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  public max_score?: number;
}
