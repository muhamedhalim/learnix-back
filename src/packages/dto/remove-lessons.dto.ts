import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsInt, ArrayMinSize, Min } from 'class-validator';

export class RemoveLessonsDto {
  @ApiProperty({
    description: 'Array of lesson IDs to remove from the package',
    example: [1, 2],
    type: [Number],
  })
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @ArrayMinSize(1, { message: 'At least one lesson ID is required' })
  lessonIds!: number[];
}
