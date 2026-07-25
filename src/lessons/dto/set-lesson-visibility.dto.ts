import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { LessonStatus } from '../entities/lesson-status.enum';

/** Publishing has its own endpoint; this DTO only permits non-public states. */
export class SetLessonVisibilityDto {
  @ApiProperty({ enum: [LessonStatus.DRAFT, LessonStatus.HIDDEN] })
  @IsEnum([LessonStatus.DRAFT, LessonStatus.HIDDEN])
  public status!: LessonStatus.DRAFT | LessonStatus.HIDDEN;
}
