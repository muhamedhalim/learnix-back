import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID, ArrayMinSize, ArrayMaxSize } from 'class-validator';

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
  @IsArray()
  @IsUUID('4', { each: true, message: 'Each subject ID must be a valid UUID' })
  @ArrayMinSize(1, { message: 'At least one subject must be provided' })
  @ArrayMaxSize(10, { message: 'Cannot assign more than 10 subjects at once' })
  subjectIds!: string[];
}
