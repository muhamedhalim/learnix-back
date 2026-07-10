import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * `homework_defaulters` is deliberately absent: there is no homework
 * submission/completion entity in this schema (assignments are lesson-wide,
 * not per-student), so "who hasn't done it" cannot be computed honestly.
 */
export enum BroadcastScope {
  CLASS = 'class',
  ABSENTEES = 'absentees',
  LOW_GRADES = 'low_grades',
}

export class TeacherBroadcastDto {
  @ApiProperty({ enum: BroadcastScope })
  @IsEnum(BroadcastScope)
  public scope!: BroadcastScope;

  @ApiPropertyOptional({ description: 'Restrict to one lesson (required for "class" and "absentees")' })
  @IsOptional()
  @IsUUID()
  public lessonId?: string;

  @ApiProperty({ description: 'Free-text message the guardian will receive, prefixed with the teacher name' })
  @IsString()
  @MinLength(1)
  @MaxLength(600)
  public message!: string;
}
