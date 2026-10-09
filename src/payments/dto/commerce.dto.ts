import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { Pagination20Dto } from '../../common/dto/pagination.dto';
import {
  CollectionParty,
  ItemType,
  ManualPaymentMethodType,
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
  @IsUUID('4')
  public booking_id?: string;

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

  @IsEnum(ManualPaymentMethodType)
  public type!: ManualPaymentMethodType;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsString()
  @Length(2, 160)
  public recipient_name!: string;

  @IsObject()
  public configuration!: Record<string, string>;

  @IsString()
  @Length(2, 5000)
  public instructions!: string;

  @IsString()
  @Length(3, 3)
  public currency = 'EGP';

  @IsOptional()
  @IsBoolean()
  public proof_required?: boolean;

  @IsOptional()
  @IsBoolean()
  public transaction_reference_required?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public internal_notes?: string;

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
  @IsEnum(ManualPaymentMethodType)
  public type?: ManualPaymentMethodType;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsOptional()
  @IsString()
  @Length(2, 160)
  public recipient_name?: string;

  @IsOptional()
  @IsObject()
  public configuration?: Record<string, string>;

  @IsOptional()
  @IsString()
  @Length(2, 5000)
  public instructions?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  public currency?: string;

  @IsOptional()
  @IsBoolean()
  public proof_required?: boolean;

  @IsOptional()
  @IsBoolean()
  public transaction_reference_required?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public internal_notes?: string | null;

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

  /** Optional only for legacy callers; new callers must reuse this value on retries. */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  public idempotency_key?: string;

  /** New callers provide a fiscal period; legacy callers receive a deterministic default. */
  @IsOptional()
  @IsString()
  @Length(7, 7)
  public fiscal_period?: string;

  /** Selects a single ledger currency for multi-currency teachers. */
  @IsOptional()
  @IsString()
  @Length(3, 3)
  public currency?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  public ledger_entry_ids?: string[];

  /** Defaults to the eligible available balance; supplied values enable partial allocation. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public amount_minor?: number;

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

/**
 * Teacher-owned payout request.  The caller is always used as the teacher ID
 * and cannot select staff-only deductions, receivable offsets, or ledger rows.
 */
export class RequestSettlementDto {
  /** A payout must be created per currency; mixed-currency allocations are never allowed. */
  @IsString()
  @Length(3, 3)
  public currency!: string;

  /** Optional only for retry compatibility; the service derives a stable fallback. */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  public idempotency_key?: string;

  @IsOptional()
  @IsString()
  @Length(7, 7)
  public fiscal_period?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public notes?: string;
}

export class PaySettlementDto {
  @IsString()
  @Length(2, 180)
  public transfer_reference!: string;

  /** Optional only for legacy endpoint compatibility; fallback is deterministic. */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  public idempotency_key?: string;

  /** Manual-transfer metadata; new admin workflow always supplies these. */
  @IsOptional()
  @IsString()
  @Length(2, 100)
  public transfer_method?: string;

  @IsOptional()
  @IsDateString()
  public transfer_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public notes?: string;
}

/** Required immutable audit reason for a terminal, unpaid settlement decision. */
export class SettlementTerminalDto {
  @IsString()
  @Length(2, 2000)
  public reason!: string;
}

export class SettlementFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsEnum(SettlementStatus)
  public status?: SettlementStatus;

  @IsOptional()
  @IsUUID('4')
  public teacher_id?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  public currency?: string;

  @IsOptional()
  @IsString()
  @Length(7, 7)
  public fiscal_period?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;
}

/**
 * Financial-audit record types a `payment_audit_logs` row can point at.
 *
 * Each one resolves to a teacher through its own join, so the list is closed —
 * an unrecognised type has no teacher and must not silently return everything.
 */
export const FINANCE_AUDIT_RESOURCE_TYPES = [
  'settlement',
  'refund',
  'order',
  'manual_payment_submission',
] as const;

export type FinanceAuditResourceType = (typeof FINANCE_AUDIT_RESOURCE_TYPES)[number];

/** Teacher-scoped financial audit trail. `teacher_id` is always `users.id`. */
export class FinanceAuditFilterDto extends Pagination20Dto {
  @IsUUID('4')
  public teacher_id!: string;

  @IsOptional()
  @IsIn(FINANCE_AUDIT_RESOURCE_TYPES)
  public resource_type?: FinanceAuditResourceType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public action?: string;

  @IsOptional()
  @IsDateString()
  public from?: string;

  @IsOptional()
  @IsDateString()
  public to?: string;
}

export const FINANCIAL_REPORT_WIDGETS = [
  'summary',
  'teacher_receivables',
  'revenue_trends',
  'product_breakdown',
  'top_products',
  'settlement_analytics',
  'ledger_movements',
  'settlement_history',
] as const;
export type FinancialReportWidget = (typeof FINANCIAL_REPORT_WIDGETS)[number];

/** Canonical paid-order reporting filter. Dates always apply to orders.paid_at. */
export class FinancialReportFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsDateString()
  public from?: string;

  @IsOptional()
  @IsDateString()
  public to?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  public currency?: string;

  @IsOptional()
  @IsUUID('4')
  public teacher_id?: string;

  @IsOptional()
  @IsEnum(ItemType)
  public item_type?: ItemType;

  @IsOptional()
  @IsEnum(SettlementStatus)
  public settlement_status?: SettlementStatus;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public payment_method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month', 'quarter'])
  public group_by?: 'day' | 'week' | 'month' | 'quarter';

  /**
   * Opt-in widget selection (comma-separated). Absent = every widget, so the
   * default body is unchanged. Unselected widgets are returned empty and are
   * never reported in `widget_errors`. The CSV export always uses the full set.
   */
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string'
      ? [
          ...new Set(
            value
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item !== ''),
          ),
        ]
      : value,
  )
  @IsArray()
  @ArrayMaxSize(FINANCIAL_REPORT_WIDGETS.length)
  @IsIn(FINANCIAL_REPORT_WIDGETS, { each: true })
  public widgets?: FinancialReportWidget[];
}
