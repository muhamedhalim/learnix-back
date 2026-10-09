import { ApiProperty } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Upper bound on lesson ids per request. Chosen as a generous ceiling for one
 * course's lesson list (no measured course-size distribution is available
 * offline: the frontend chunks anything longer, so the cap bounds work per
 * request rather than limiting what a course can contain).
 */
export const LESSON_ANALYTICS_BATCH_MAX = 100;

export class LessonAnalyticsBatchQueryDto {
  @ApiProperty({
    description: 'Comma-separated lesson UUIDs',
    example: '3f2b1c9e-0000-4000-8000-000000000001,3f2b1c9e-0000-4000-8000-000000000002',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
      : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(LESSON_ANALYTICS_BATCH_MAX)
  @IsUUID('4', { each: true })
  public lesson_ids!: string[];
}
