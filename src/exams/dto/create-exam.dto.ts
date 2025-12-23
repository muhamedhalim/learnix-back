import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsInt,
  Min,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionDto } from './question.dto';

export class CreateExamDto {
  @ApiProperty({
    description: 'Exam title in English',
    example: 'Math Final Exam',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  @MaxLength(255)
  title!: string;

  @ApiProperty({
    description: 'Exam title in Arabic',
    example: 'امتحان الرياضيات النهائي',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty({ message: 'Arabic title is required' })
  @MaxLength(255)
  title_ar!: string;

  @ApiProperty({
    description: 'Exam description in English',
    example: 'Final exam covering algebra and geometry',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Exam description in Arabic',
    example: 'الامتحان النهائي يغطي الجبر والهندسة',
    required: false,
  })
  @IsString()
  @IsOptional()
  description_ar?: string;

  @ApiProperty({
    description: 'Subject ID this exam belongs to',
    example: 1,
  })
  @IsInt()
  @Min(1)
  subject_id!: number;

  @ApiProperty({
    description: 'Exam duration in seconds',
    example: 5400,
    minimum: 60,
  })
  @IsInt()
  @Min(60, { message: 'Duration must be at least 60 seconds (1 minute)' })
  duration!: number;

  @ApiProperty({
    description: 'Passing marks (must be <= total marks from questions)',
    example: 60,
    minimum: 0,
  })
  @IsInt()
  @Min(0, { message: 'Passing marks cannot be negative' })
  passing_marks!: number;

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
  questions!: QuestionDto[];
}
