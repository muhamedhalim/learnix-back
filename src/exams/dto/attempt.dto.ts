import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** One answer in an autosave / submit payload. `response: null` clears the answer. */
export class SaveAnswerItemDto {
  @ApiProperty({ description: 'The exam_question this answer belongs to (UUID)' })
  @IsUUID('4')
  public exam_question_id!: string;

  @ApiPropertyOptional({ description: 'Type-specific response payload, or null to clear' })
  @IsOptional()
  @ValidateIf((o: SaveAnswerItemDto) => o.response !== null)
  @IsObject()
  public response?: Record<string, unknown> | null;

  @ApiPropertyOptional({ minimum: 0, description: 'Time spent on this question (ms)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  public time_spent_ms?: number;
}

/** Debounced autosave of one or more answers during an in-progress attempt. */
export class SaveAnswersDto {
  @ApiProperty({ type: [SaveAnswerItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveAnswerItemDto)
  public answers!: SaveAnswerItemDto[];
}

/** Finalise an attempt. Optionally flushes a final batch of answers first. */
export class SubmitAttemptDto {
  @ApiPropertyOptional({ description: 'Idempotency key to make submit safe to retry' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public idempotency_key?: string;

  @ApiPropertyOptional({ type: [SaveAnswerItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveAnswerItemDto)
  public answers?: SaveAnswerItemDto[];
}

/** Teacher grade for a single manual (essay/file) answer. */
export class GradeAnswerDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  public score!: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public feedback?: string;
}
