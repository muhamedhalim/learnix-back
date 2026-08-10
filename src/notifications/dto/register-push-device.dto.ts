import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsEnum, IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator';

import { PushPlatform, PushProviderName } from '../entities';

/**
 * There is deliberately NO `user_id` here.
 *
 * Device ownership is derived from the authenticated principal, so registering
 * a token against another account is not a request the API can express — it is
 * not merely rejected by a check that a future refactor might drop.
 */
export class RegisterPushDeviceDto {
  @ApiProperty({
    description:
      'Provider registration token obtained by the client (FCM getToken). Stored ' +
      'server-side, never returned by the API, and never logged in full.',
    maxLength: 4096,
  })
  @IsString()
  @IsNotEmpty()
  // FCM web/mobile tokens are ~150–350 chars today, but the format is not
  // contractual; the bound only stops an unbounded body from reaching storage.
  @Length(20, 4096)
  public token!: string;

  @ApiPropertyOptional({ enum: PushPlatform, default: PushPlatform.WEB })
  @IsEnum(PushPlatform)
  @IsOptional()
  public platform?: PushPlatform;

  @ApiPropertyOptional({ enum: PushProviderName, default: PushProviderName.FCM })
  @IsEnum(PushProviderName)
  @IsOptional()
  public provider?: PushProviderName;

  @ApiPropertyOptional({
    description:
      'Stable client-generated install identifier. Supplying it lets a token ' +
      'refresh update this device instead of creating a second registration.',
    maxLength: 200,
  })
  @IsString()
  @IsOptional()
  @Length(8, 200)
  // Opaque identifier only — constrained so it cannot smuggle structure.
  @Matches(/^[\w.:-]+$/, {
    message: 'device_id may contain letters, digits, dot, colon, underscore and hyphen only',
  })
  public device_id?: string;

  @ApiPropertyOptional({
    description: 'Human-readable client hint, e.g. "Chrome on Windows".',
    maxLength: 200,
  })
  @IsString()
  @IsOptional()
  @Length(1, 200)
  public device_label?: string;
}

/** Logout / "turn push off on this device": revoke by the token the client holds. */
export class UnregisterPushDeviceDto {
  @ApiProperty({ maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @Length(20, 4096)
  public token!: string;

  @ApiPropertyOptional({ enum: PushProviderName, default: PushProviderName.FCM })
  @IsEnum(PushProviderName)
  @IsOptional()
  public provider?: PushProviderName;
}
