import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  Min,
  IsNumber,
  IsString,
  IsOptional,
  MaxLength,
} from 'class-validator';

/**
 * DTO for grading an essay question
 *
 * Teachers can grade one essay at a time.
 * When all essays are graded, the exam attempt status changes to GRADED.
 */
export class GradeEssayDto {
  @ApiProperty({
    description: 'ID of the student whose essay is being graded',
    example: 1,
  })
  @IsInt({ message: 'Student ID must be an integer' })
  @Min(1, { message: 'Invalid student ID' })
  student_id!: number;

  @ApiProperty({
    description: 'Index of the question being graded (0-based)',
    example: 1,
  })
  @IsInt({ message: 'Question index must be an integer' })
  @Min(0, { message: 'Question index cannot be negative' })
  question_index!: number;

  @ApiProperty({
    description: 'Score to award (must be <= question marks)',
    example: 8,
    minimum: 0,
  })
  @IsNumber({}, { message: 'Score must be a number' })
  @Min(0, { message: 'Score cannot be negative' })
  score!: number;

  @ApiProperty({
    description: 'Optional feedback for the student',
    example: 'Good explanation but missing some key details',
    required: false,
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000, { message: 'Feedback cannot exceed 1000 characters' })
  feedback?: string;
}
