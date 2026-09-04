import { IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, Length } from 'class-validator';

import { bi } from '../../../i18n/error-translator.util';
import { MarketplaceListQueryDto } from '../../common/dto/marketplace-pagination.dto';
import { PayoutRequestStatus } from '../../common/enums';

/** FR-206 — `amount_minor` is a client-stated minimum; `PayoutRequestService.createRequest()` resolves the real, earning-backed total. */
export class CreatePayoutRequestDto {
  @IsUUID('4')
  payout_account_id!: string;

  @IsInt()
  @IsPositive({ message: bi('amount_minor must be greater than zero', 'يجب أن يكون المبلغ أكبر من صفر') })
  amount_minor!: number;

  @IsString()
  @Length(3, 3)
  currency!: string;
}

/** T214 — the admin payout queue's page size is validated the same as every other marketplace list, not left to raw unchecked query params. */
export class AdminPayoutQueueQueryDto extends MarketplaceListQueryDto {
  @IsOptional()
  @IsEnum(PayoutRequestStatus)
  public status?: PayoutRequestStatus;
}
