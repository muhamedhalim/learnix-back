import { ApiProperty } from '@nestjs/swagger';

import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `parent_phone` was removed from this DTO on purpose. It let a student rewrite
 * the number their own grade notifications are sent to. Guardians are now
 * managed under `/student/guardians`, where a verified number is immutable
 * without a fresh OTP.
 */
export class UpdateStudentProfileDto {
  @ApiProperty({ description: 'Opt in to the public game profile and leaderboards', required: false })
  @IsBoolean()
  @IsOptional()
  public is_public_profile?: boolean;

  @ApiProperty({ description: 'Country (for public leaderboards)', required: false, maxLength: 100 })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  public country?: string;

  @ApiProperty({ description: 'Governorate (for public leaderboards)', required: false, maxLength: 100 })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  public governorate?: string;

  @ApiProperty({ description: 'School (for public leaderboards)', required: false, maxLength: 150 })
  @IsString()
  @IsOptional()
  @MaxLength(150)
  public school?: string;
}

export class UpdateStudentNotificationSettingsDto {
  @IsObject()
  public notification_settings!: Record<string, boolean>;
}
