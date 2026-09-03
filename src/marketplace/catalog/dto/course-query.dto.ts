import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { MarketplaceCourseStatus } from '../../common/enums';

export class CourseStatusQueryDto {
  @ApiPropertyOptional({ enum: MarketplaceCourseStatus })
  @IsOptional()
  @IsEnum(MarketplaceCourseStatus)
  public status?: MarketplaceCourseStatus;
}
