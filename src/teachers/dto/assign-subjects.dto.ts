import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsInt, ArrayMinSize, ArrayMaxSize } from 'class-validator';

export class AssignSubjectsDto {
  @ApiProperty({
    description: 'Array of subject IDs to assign to the teacher',
    example: [1, 2, 3],
    type: [Number],
    minItems: 1,
    maxItems: 10,
  })
  @IsArray()
  @IsInt({ each: true })
  @ArrayMinSize(1, { message: 'At least one subject must be provided' })
  @ArrayMaxSize(10, { message: 'Cannot assign more than 10 subjects at once' })
  subjectIds!: number[];
}
