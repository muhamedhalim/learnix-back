import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsArray, ArrayMinSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AnswerDto } from './question.dto';

/**
 * DTO for submitting exam answers
 *
 * Students must provide answers for ALL questions.
 * MCQ answers are auto-graded immediately.
 * Essay answers will have score=null until teacher grades them.
 */
export class SubmitExamDto {
  @ApiProperty({
    description: 'ID of the exam being submitted (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4', { message: 'Exam ID must be a valid UUID' })
  exam_id!: string;

  @ApiProperty({
    description: 'Array of student answers (one per question)',
    type: [AnswerDto],
    example: [
      { question_index: 0, answer: '4' },
      {
        question_index: 1,
        answer:
          "Newton's first law states that an object at rest stays at rest...",
      },
    ],
  })
  @IsArray({ message: 'Answers must be an array' })
  @ArrayMinSize(1, { message: 'At least one answer is required' })
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers!: AnswerDto[];
}
