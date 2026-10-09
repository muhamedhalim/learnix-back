import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../../common/decorators/strict-integer-query.decorator';
import { OrderStatusQueryDto } from './order-status-query.dto';

/** `GET /marketplace/me/orders`: the status filter plus a bounded page (T095 / E-014: default 20, max 100). */
export class OrderListQueryDto extends OrderStatusQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  public limit = 20;
}
