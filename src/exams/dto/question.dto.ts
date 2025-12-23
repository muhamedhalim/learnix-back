import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  Min,
  ValidateIf,
} from 'class-validator';
import { QuestionType } from '../entities';

/**
 * DTO for exam questions
 *
 * Conditional validation:
 * - MCQ requires: choices (2-6), correct_answer (must be in choices)
 * - Essay: choices and correct_answer must NOT be provided
 */
export class QuestionDto {
  @ApiProperty({
    description: 'Question type (mcq or essay)',
    enum: QuestionType,
    example: QuestionType.MCQ,
  })
  @IsEnum(QuestionType, { message: 'Type must be either mcq or essay' })
  type!: QuestionType;

  @ApiProperty({
    description: 'Question text in English',
    example: 'What is 2 + 2?',
  })
  @IsString()
  @IsNotEmpty({ message: 'Question text is required' })
  question!: string;

  @ApiProperty({
    description: 'Question text in Arabic',
    example: 'ما هو 2 + 2؟',
  })
  @IsString()
  @IsNotEmpty({ message: 'Arabic question text is required' })
  question_ar!: string;

  @ApiProperty({
    description: 'Answer choices (required for MCQ, 2-6 options)',
    example: ['1', '2', '4', '5'],
    required: false,
  })
  @ValidateIf((o: QuestionDto) => o.type === QuestionType.MCQ)
  @IsArray({ message: 'Choices must be an array' })
  @ArrayMinSize(2, { message: 'MCQ must have at least 2 choices' })
  @ArrayMaxSize(6, { message: 'MCQ cannot have more than 6 choices' })
  @IsString({ each: true, message: 'Each choice must be a string' })
  choices?: string[];

  @ApiProperty({
    description:
      'Correct answer (required for MCQ, must match one of the choices)',
    example: '4',
    required: false,
  })
  @ValidateIf((o: QuestionDto) => o.type === QuestionType.MCQ)
  @IsString({ message: 'Correct answer must be a string' })
  @IsNotEmpty({ message: 'Correct answer is required for MCQ' })
  correct_answer?: string;

  @ApiProperty({
    description: 'Marks for this question',
    example: 5,
    minimum: 1,
  })
  @IsInt({ message: 'Marks must be an integer' })
  @Min(1, { message: 'Marks must be at least 1' })
  marks!: number;
}

/**
 * DTO for student answers when submitting exam
 */
export class AnswerDto {
  @ApiProperty({
    description: 'Question index (0-based)',
    example: 0,
    minimum: 0,
  })
  @IsInt({ message: 'Question index must be an integer' })
  @Min(0, { message: 'Question index cannot be negative' })
  question_index!: number;

  @ApiProperty({
    description: 'Student answer text',
    example: '4',
  })
  @IsString({ message: 'Answer must be a string' })
  @IsNotEmpty({ message: 'Answer is required' })
  answer!: string;
}
