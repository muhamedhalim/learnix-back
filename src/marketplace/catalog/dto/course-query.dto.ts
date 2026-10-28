import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { MarketplaceCourseStatus } from '../../common/enums';

export class CourseStatusQueryDto {
  @ApiPropertyOptional({ enum: MarketplaceCourseStatus })
  @IsOptional()
  @IsEnum(MarketplaceCourseStatus)
  public status?: MarketplaceCourseStatus;
}

/** Admin course list: the status filter plus the queue of material edits awaiting a decision on published courses (FR-071). */
export class AdminCourseQueryDto extends CourseStatusQueryDto {
  @ApiPropertyOptional({
    description: 'Only published courses with a material edit awaiting review',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  public pending_edit?: boolean;
}
