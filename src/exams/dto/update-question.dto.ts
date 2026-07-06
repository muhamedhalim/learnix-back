import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { BloomLevel, Difficulty } from '../entities';

/**
 * Update a bank question. The immutable `type` is intentionally excluded —
 * changing a question's type would invalidate its version history and any exam
 * that pinned it; create a new question instead. Editing `content`/`answer_key`
 * creates a new version (handled by the service).
 */
export class UpdateQuestionDto {
  @ApiPropertyOptional({ description: 'Subject UUID' })
  @IsOptional()
  @IsUUID('4')
  public subject_id?: string;

  @ApiPropertyOptional({ description: 'Lesson UUID' })
  @IsOptional()
  @IsUUID('4')
  public lesson_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public chapter?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public topic?: string;

  @ApiPropertyOptional({ enum: Difficulty })
  @IsOptional()
  @IsEnum(Difficulty)
  public difficulty?: Difficulty;

  @ApiPropertyOptional({ enum: BloomLevel })
  @IsOptional()
  @IsEnum(BloomLevel)
  public bloom_level?: BloomLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  public content?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  public answer_key?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  public default_marks?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public tags?: string[];
}
