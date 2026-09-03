import { IsEnum, IsString, MinLength } from 'class-validator';

import { CourseRemovalCause } from '../../common/enums';

export class RemoveCourseDto {
  @IsEnum(CourseRemovalCause)
  public cause!: CourseRemovalCause;

  @IsString()
  @MinLength(1)
  public reason!: string;
}
