import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Every marketplace admin decision that requires a mandatory reason
 * (application rejection FR-018, resubmission-attempts reset FR-016,
 * instructor suspension FR-021, profile-change rejection FR-029, refund
 * decision FR-198, ...) shares this one shape, so it is not redeclared
 * per controller.
 */
export class MarketplaceReasonDto {
  @ApiProperty({ description: 'Why this decision was made. Shown to the affected party.', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason!: string;
}
