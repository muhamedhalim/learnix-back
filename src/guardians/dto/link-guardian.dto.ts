import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsBoolean, IsEnum, IsOptional, IsString, Length } from 'class-validator';

import { GuardianRelationship, PreferredLanguage } from '../entities';

export class LinkGuardianDto {
  @ApiProperty({
    description:
      'Guardian phone number. Accepts Egyptian national (01012345678) or E.164 (+201012345678); stored canonically as E.164.',
    example: '01012345678',
  })
  @IsString()
  // Deliberately no @Matches here: `toE164` in the service is the single source
  // of truth for what a valid number is, and it accepts more spellings than any
  // one regex should encode. It throws a 400 with the same message on failure.
  public phone!: string;

  @ApiPropertyOptional({ description: 'Guardian full name', example: 'أحمد محمود' })
  @IsOptional()
  @IsString()
  @Length(2, 150)
  public full_name?: string;

  @ApiPropertyOptional({ enum: GuardianRelationship, default: GuardianRelationship.OTHER })
  @IsOptional()
  @IsEnum(GuardianRelationship)
  public relationship?: GuardianRelationship;

  @ApiPropertyOptional({ enum: PreferredLanguage, default: PreferredLanguage.AR })
  @IsOptional()
  @IsEnum(PreferredLanguage)
  public preferred_language?: PreferredLanguage;

  @ApiPropertyOptional({
    description: 'Make this the primary guardian (demotes any existing primary).',
  })
  @IsOptional()
  @IsBoolean()
  public is_primary?: boolean;
}
