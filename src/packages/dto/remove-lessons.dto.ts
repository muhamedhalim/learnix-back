import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class RemoveLessonsDto {
  @ApiProperty({
    description: 'Array of lesson IDs to remove from the package',
    example: ['123e4567-e89b-12d3-a456-426614174000'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least one lesson ID is required' })
  lessonIds!: string[];
}
