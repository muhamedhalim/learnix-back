import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { MarketplaceListQueryDto } from '../../common/dto/marketplace-pagination.dto';
import { InstructorApplicationStatus } from '../../common/enums';

export class ApplicationQueueQueryDto extends MarketplaceListQueryDto {
  @ApiPropertyOptional({ enum: InstructorApplicationStatus })
  @IsOptional()
  @IsEnum(InstructorApplicationStatus)
  public status?: InstructorApplicationStatus;
}
