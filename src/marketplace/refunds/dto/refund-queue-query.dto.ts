import { IsEnum, IsOptional } from 'class-validator';

import { MarketplaceListQueryDto } from '../../common/dto/marketplace-pagination.dto';
import { RefundRequestStatus } from '../../common/enums';

/** T214 — the admin refund queue's page size is validated the same as every other marketplace list, not left to raw unchecked query params. */
export class AdminRefundQueueQueryDto extends MarketplaceListQueryDto {
  @IsOptional()
  @IsEnum(RefundRequestStatus)
  public status?: RefundRequestStatus;
}
