import { ApiProperty } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class PackageLessonItemDto {
  @IsString()
  public lessonId!: string;

  @ApiProperty({
    description: 'Order index for the lesson in the package (0-based)',
    example: 0,
    minimum: 0,
  })
  @Min(0)
  public orderIndex!: number;
}

export class AddLessonsDto {
  @ApiProperty({
    description: 'Array of lessons to add to the package',
    type: [PackageLessonItemDto],
    example: [
      { lessonId: '123e4567-e89b-12d3-a456-426614174000', orderIndex: 0 },
      { lessonId: '223e4567-e89b-12d3-a456-426614174001', orderIndex: 1 },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1, {
    message: bi('At least one lesson is required', 'يلزم درس واحد على الأقل'),
  })
  @ArrayMaxSize(20, {
    message: bi('Maximum 20 lessons per package', 'الحد الأقصى 20 درسًا لكل باقة'),
  })
  @Type(() => PackageLessonItemDto)
  public lessons!: PackageLessonItemDto[];
}
