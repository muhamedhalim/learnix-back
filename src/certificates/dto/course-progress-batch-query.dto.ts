import { ApiProperty } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class CourseProgressBatchQueryDto {
  @ApiProperty({ description: 'Comma-separated course (package) UUIDs, at most 100' })
  @Transform(({ value }): unknown =>
    typeof value === 'string'
      ? [
          ...new Set(
            value
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item !== ''),
          ),
        ]
      : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  public package_ids!: string[];
}
