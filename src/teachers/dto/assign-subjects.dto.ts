import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize } from 'class-validator';

export class AssignSubjectsDto {
  @ApiProperty({
    description: 'Array of subject IDs (UUIDs) to assign to the teacher',
    example: [
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    ],
    type: [String],
    minItems: 1,
    maxItems: 10,
  })
  @ArrayMaxSize(10, { message: 'Cannot assign more than 10 subjects at once' })
  public subjectIds!: string[];
}
