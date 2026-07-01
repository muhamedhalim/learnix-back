import { ApiProperty } from '@nestjs/swagger';

import { IsEnum } from 'class-validator';

import { CourseStatus } from '../entities/course-status.enum';

export class UpdateCourseStatusDto {
  @ApiProperty({ enum: CourseStatus, description: 'New publishing state' })
  @IsEnum(CourseStatus)
  public status!: CourseStatus;
}
