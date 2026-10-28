import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * D1: the gateway has no refund API, so an administrator pays the learner back (EasyKash dashboard,
 * bank transfer, wallet) and records here what proves it. The reference is the audit trail for that
 * money movement, so it is mandatory, and one reference can close only one refund.
 */
export class CompleteManualRefundDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  // `refund_reference` is varchar(180).
  @MaxLength(180)
  public refundReference!: string;
}
