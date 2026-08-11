import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Admin-only filters for the Call Center workforce list. The role is fixed by
 * the endpoint, so callers cannot use this DTO to enumerate other roles.
 */
export class CallCenterEmployeeFilterDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Search by name, username, email, or phone number',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;
}
