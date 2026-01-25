import { ApiProperty } from '@nestjs/swagger';

import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * DTO for grading an essay question
 *
 * Teachers can grade one essay at a time.
 * When all essays are graded, the exam attempt status changes to GRADED.
 */
export class GradeEssayDto {
  @IsUUID('4', { message: 'Student ID must be a valid UUID' })
  public student_id!: string;

  @ApiProperty({
    description: 'Index of the question being graded (0-based)',
    example: 1,
  })
  @Min(0, { message: 'Question index cannot be negative' })
  public question_index!: number;

  @ApiProperty({
    description: 'Score to award (must be <= question marks)',
    example: 8,
    minimum: 0,
  })
  @Min(0, { message: 'Score cannot be negative' })
  public score!: number;

  @ApiProperty({
    description: 'Optional feedback for the student',
    example: 'Good explanation but missing some key details',
    required: false,
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000, { message: 'Feedback cannot exceed 1000 characters' })
  public feedback?: string;
}
