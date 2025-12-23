import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PackageLessonItemDto {
  @ApiProperty({
    description: 'Lesson ID to add to the package',
    example: 1,
  })
  @IsInt()
  @Min(1)
  lessonId!: number;

  @ApiProperty({
    description: 'Order index for the lesson in the package (0-based)',
    example: 0,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  orderIndex!: number;
}

export class AddLessonsDto {
  @ApiProperty({
    description: 'Array of lessons to add to the package',
    type: [PackageLessonItemDto],
    example: [
      { lessonId: 1, orderIndex: 0 },
      { lessonId: 2, orderIndex: 1 },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1, { message: 'At least one lesson is required' })
  @ArrayMaxSize(20, { message: 'Maximum 20 lessons per package' })
  @Type(() => PackageLessonItemDto)
  lessons!: PackageLessonItemDto[];
}
