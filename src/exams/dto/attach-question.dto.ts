import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

/**
 * Attach a bank question to an exam section. The service snapshots the pinned
 * question version's content/answer-key onto the created exam-question row.
 */
export class AttachQuestionDto {
  @ApiProperty({ description: 'Bank question UUID' })
  @IsUUID('4')
  public question_id!: string;

  @ApiProperty({ description: 'Target section UUID' })
  @IsUUID('4')
  public section_id!: string;

  @ApiPropertyOptional({ minimum: 1, description: 'Marks override (defaults to question default)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  public marks?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Weight multiplier (default 1)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  public weight?: number;

  @ApiPropertyOptional({ description: 'Bonus question (adds to score, not to max)' })
  @IsOptional()
  @IsBoolean()
  public is_bonus?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public required?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  public order_index?: number;
}
