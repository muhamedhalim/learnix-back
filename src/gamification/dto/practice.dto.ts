import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsEnum, IsInt, IsObject, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { Difficulty } from '../../exams/entities/difficulty.enum';

/** Filter which question the practice picker serves next. */
export class GetNextQuestionQueryDto {
  @ApiPropertyOptional({ description: 'Restrict to a subject' })
  @IsOptional()
  @IsUUID('4')
  public subject_id?: string;

  @ApiPropertyOptional({ enum: Difficulty, description: 'Restrict to a difficulty' })
  @IsOptional()
  @IsEnum(Difficulty)
  public difficulty?: Difficulty;
}

/** Submit an answer to a practice question. */
export class SubmitAnswerDto {
  @ApiProperty({ description: 'The question being answered (UUID)' })
  @IsUUID('4')
  public question_id!: string;

  @ApiPropertyOptional({ description: 'Type-specific response payload (null = unanswered)' })
  @IsOptional()
  @IsObject()
  public response?: Record<string, unknown> | null;

  @ApiProperty({ description: 'Client-measured think time in ms', example: 8000 })
  @IsInt()
  @Min(0)
  @Max(3_600_000)
  public time_ms!: number;

  @ApiPropertyOptional({ description: 'Active practice session (for combo/analytics)' })
  @IsOptional()
  @IsUUID('4')
  public session_id?: string;
}

/** Open a practice session (groups solves for combo + velocity). */
export class StartSessionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  public subject_id?: string;

  @ApiPropertyOptional({ enum: Difficulty })
  @IsOptional()
  @IsEnum(Difficulty)
  public difficulty?: Difficulty;
}
