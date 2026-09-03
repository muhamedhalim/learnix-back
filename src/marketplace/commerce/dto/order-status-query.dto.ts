import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { MarketplaceOrderStatus } from '../../common/enums';

export class OrderStatusQueryDto {
  @ApiPropertyOptional({ enum: MarketplaceOrderStatus })
  @IsOptional()
  @IsEnum(MarketplaceOrderStatus)
  public status?: MarketplaceOrderStatus;
}
