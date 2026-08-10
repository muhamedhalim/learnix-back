import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { BillingDataDto } from '../../payments/dto/billing-data.dto';
import { PaymentMethod } from '../../payments/entities/payment-method.enum';

/**
 * Cart checkout intentionally supports only the configured hosted gateway.
 * Activation codes remain product-specific and must be redeemed separately.
 */
export class CheckoutCartDto {
  @IsIn([PaymentMethod.CARD])
  public payment_method!: PaymentMethod.CARD;

  @ValidateNested()
  @Type(() => BillingDataDto)
  public billing_data!: BillingDataDto;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  public discount_code?: string;

  /** Reusing this value returns the original checkout instead of a new charge. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public idempotency_key?: string;
}
