import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectPayoutDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** FR-219, FR-220 — the reference is mandatory, never inferred. */
export class MarkPayoutPaidDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(180)
  payout_reference!: string;
}

export class MarkPayoutFailedDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
