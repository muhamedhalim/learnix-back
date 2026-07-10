import { ApiProperty } from '@nestjs/swagger';

import { IsString, Matches } from 'class-validator';

export class VerifyGuardianDto {
  @ApiProperty({ description: 'The 6-digit code sent to the guardian', example: '482913' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Verification code must be 6 digits' })
  public code!: string;
}

export class ChangeGuardianPhoneDto {
  @ApiProperty({ description: 'New phone number (rejected while the guardian is verified)' })
  @IsString()
  public phone!: string;
}
