import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Every marketplace admin decision that requires a mandatory reason
 * (application rejection FR-018, resubmission-attempts reset FR-016,
 * instructor suspension FR-021, profile-change rejection FR-029, refund
 * decision FR-198, ...) shares this one shape, so it is not redeclared
 * per controller.
 *
 * Trimmed before validation: `@IsNotEmpty()` alone accepts `"   "`, which would
 * persist a blank reason that the affected party is then shown.
 */
export class MarketplaceReasonDto {
  @ApiProperty({ description: 'Why this decision was made. Shown to the affected party.', maxLength: 1000 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason!: string;
}
