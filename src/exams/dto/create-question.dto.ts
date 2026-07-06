import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

import { BloomLevel, Difficulty, QuestionType } from '../entities';

/**
 * Create a bank question. The `content` / `answer_key` payloads are validated
 * shallowly here (they are polymorphic JSON) and deeply by the matching
 * question-type definition in the service.
 */
export class CreateQuestionDto {
  @ApiProperty({ enum: QuestionType })
  @IsEnum(QuestionType)
  public type!: QuestionType;

  @ApiProperty({ description: 'Subject UUID' })
  @IsUUID('4')
  public subject_id!: string;

  @ApiPropertyOptional({ description: 'Optional lesson UUID for taxonomy/analytics' })
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

  @ApiProperty({ description: 'Type-specific presentation payload (prompt, options, media)' })
  @IsObject()
  public content!: Record<string, unknown>;

  @ApiProperty({ description: 'Type-specific correct answer + grading params' })
  @IsObject()
  public answer_key!: Record<string, unknown>;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  public default_marks!: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public tags?: string[];
}
