import { IsInt, IsPositive, IsString, IsUUID, Length } from 'class-validator';

import { bi } from '../../../i18n/error-translator.util';

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
