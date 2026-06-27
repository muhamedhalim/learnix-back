import { ApiProperty } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { QuestionDto } from './question.dto';

export class CreateExamDto {
  @MaxLength(255)
  public title!: string;

  @MaxLength(255)
  public title_ar!: string;

  @ApiProperty({
    description: 'Exam description in English',
    example: 'Final exam covering algebra and geometry',
    required: false,
  })
  @IsString()
  @IsOptional()
  public description?: string;

  @ApiProperty({
    description: 'Exam description in Arabic',
    example: 'الامتحان النهائي يغطي الجبر والهندسة',
    required: false,
  })
  @IsString()
  @IsOptional()
  public description_ar?: string;

  @ApiProperty({
    description: 'Subject ID this exam belongs to (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4', { message: 'Subject ID must be a valid UUID' })
  public subject_id!: string;

  @ApiProperty({
    description: 'Exam duration in seconds',
    example: 5400,
    minimum: 60,
  })
  @IsInt()
  @Min(60, { message: 'Duration must be at least 60 seconds (1 minute)' })
  public duration!: number;

  @ApiProperty({
    description: 'Passing marks (must be <= total marks from questions)',
    example: 60,
    minimum: 0,
  })
  @Min(0, { message: 'Passing marks cannot be negative' })
  public passing_marks!: number;

  @ApiProperty({
    description: 'Array of questions (MCQ and/or Essay)',
    type: [QuestionDto],
    example: [
      {
        type: 'mcq',
        question: 'What is 2+2?',
        question_ar: 'ما هو 2+2؟',
        choices: ['1', '2', '4', '5'],
        correct_answer: '4',
        marks: 5,
      },
      {
        type: 'essay',
        question: "Explain Newton's first law",
        question_ar: 'اشرح قانون نيوتن الأول',
        marks: 10,
      },
    ],
  })
  @IsArray({ message: 'Questions must be an array' })
  @ArrayMinSize(1, { message: 'Exam must have at least 1 question' })
  @ValidateNested({ each: true })
  @Type(() => QuestionDto)
  public questions!: QuestionDto[];
}
