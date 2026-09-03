import { IsEnum, IsInt, IsNotEmpty, IsPositive, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { MarketplaceLedgerDirection } from '../../common/enums';

/** FR-168, FR-173, FR-288. */
export class CreateLedgerAdjustmentDto {
  @IsUUID('4')
  instructorId!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;

  @IsInt()
  @IsPositive()
  amountMinor!: number;

  @IsEnum(MarketplaceLedgerDirection)
  direction!: MarketplaceLedgerDirection;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
