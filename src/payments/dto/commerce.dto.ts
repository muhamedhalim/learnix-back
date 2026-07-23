import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { Pagination20Dto } from '../../common/dto/pagination.dto';
import {
  CollectionParty,
  ItemType,
  ManualPaymentSubmissionStatus,
  OrderStatus,
  PaymentChannel,
  RefundStatus,
  SettlementStatus,
} from '../entities';
import { BillingDataDto } from './billing-data.dto';

export class CheckoutQuoteDto {
  @IsEnum(ItemType)
  public item_type!: ItemType;

  @IsUUID('4')
  public item_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  public discount_code?: string;
}

export class CreateOrderDto extends CheckoutQuoteDto {
  @IsEnum(PaymentChannel)
  public payment_channel!: PaymentChannel;

  @IsOptional()
  @IsUUID('4')
  public manual_payment_method_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  public idempotency_key?: string;
}

export class StartGatewayCheckoutDto {
  @ValidateNested()
  @Type(() => BillingDataDto)
  public billing_data!: BillingDataDto;
}

export class OrderFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsEnum(OrderStatus)
  public status?: OrderStatus;

  @IsOptional()
  @IsEnum(PaymentChannel)
  public channel?: PaymentChannel;

  @IsOptional()
  @IsEnum(ItemType)
  public item_type?: ItemType;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  public currency?: string;

  @IsOptional()
  @IsUUID('4')
  public student_id?: string;

  @IsOptional()
  @IsUUID('4')
  public teacher_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @IsOptional()
  @IsDateString()
  public from?: string;

  @IsOptional()
  @IsDateString()
  public to?: string;
}

export class CreateManualPaymentMethodDto {
  @IsString()
  @Length(2, 120)
  public name!: string;

  @IsString()
  @Length(2, 120)
  public name_ar!: string;

  @IsString()
  @Length(2, 40)
  public type!: string;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  public display_order?: number;

  @IsString()
  @Length(2, 160)
  public recipient_name!: string;

  @IsObject()
  public destination_details!: Record<string, string>;

  @IsString()
  @Length(2, 5000)
  public instructions!: string;

  @IsString()
  @Length(2, 5000)
  public instructions_ar!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public minimum_amount_minor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public maximum_amount_minor?: number;

  @IsString()
  @Length(3, 3)
  public currency = 'EGP';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(43_200)
  public order_expiration_minutes?: number;

  @IsOptional()
  @IsBoolean()
  public proof_required?: boolean;

  @IsOptional()
  @IsBoolean()
  public reference_required?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public countries?: string[];

  @IsOptional()
  @IsEnum(CollectionParty)
  public collection_party?: CollectionParty;
}

export class UpdateManualPaymentMethodDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  public name?: string;

  @IsOptional()
  @IsString()
  @Length(2, 120)
  public name_ar?: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  public type?: string;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  public display_order?: number;

  @IsOptional()
  @IsString()
  @Length(2, 160)
  public recipient_name?: string;

  @IsOptional()
  @IsObject()
  public destination_details?: Record<string, string>;

  @IsOptional()
  @IsString()
  @Length(2, 5000)
  public instructions?: string;

  @IsOptional()
  @IsString()
  @Length(2, 5000)
  public instructions_ar?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public minimum_amount_minor?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public maximum_amount_minor?: number | null;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  public currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(43_200)
  public order_expiration_minutes?: number;

  @IsOptional()
  @IsBoolean()
  public proof_required?: boolean;

  @IsOptional()
  @IsBoolean()
  public reference_required?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public countries?: string[] | null;

  @IsOptional()
  @IsEnum(CollectionParty)
  public collection_party?: CollectionParty;
}

export class SubmitManualPaymentDto {
  @IsUUID('4')
  public order_id!: string;

  @IsUUID('4')
  public manual_payment_method_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public claimed_amount_minor!: number;

  @IsString()
  @Length(3, 3)
  public currency!: string;

  @IsString()
  @Length(2, 160)
  public payer_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public payer_account_hint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public transaction_reference?: string;

  @IsOptional()
  @IsDateString()
  public paid_at_claimed?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public student_note?: string;
}

export class ReviewManualPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public reviewer_note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public override_reason?: string;
}

export class RejectManualPaymentDto extends ReviewManualPaymentDto {
  @IsString()
  @IsNotEmpty()
  public reason_code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public reason?: string;
}

export class ManualSubmissionFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsEnum(ManualPaymentSubmissionStatus)
  public status?: ManualPaymentSubmissionStatus;

  @IsOptional()
  @IsUUID('4')
  public method_id?: string;
}

export class CreateRefundDto {
  @IsUUID('4')
  public order_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public amount_minor!: number;

  @IsString()
  @Length(2, 80)
  public reason_code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public internal_note?: string;
}

export class CompleteRefundDto {
  @IsString()
  @Length(2, 120)
  public external_method!: string;

  @IsString()
  @Length(2, 180)
  public external_reference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public note?: string;
}

export class RefundFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsEnum(RefundStatus)
  public status?: RefundStatus;

  @IsOptional()
  @IsUUID('4')
  public teacher_id?: string;
}

export class CreateSettlementDto {
  @IsUUID('4')
  public teacher_id!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  public ledger_entry_ids?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public deductions_minor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public receivable_offset_minor?: number;

  @IsString()
  @Length(2, 100)
  public payment_method!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public notes?: string;
}

export class PaySettlementDto {
  @IsString()
  @Length(2, 180)
  public transfer_reference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public notes?: string;
}

export class SettlementFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsEnum(SettlementStatus)
  public status?: SettlementStatus;

  @IsOptional()
  @IsUUID('4')
  public teacher_id?: string;
}
