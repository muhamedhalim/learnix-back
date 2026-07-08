import { ApiProperty } from '@nestjs/swagger';

import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateStudentProfileDto {
  @ApiProperty({
    description: 'Parent phone number (Egyptian mobile)',
    example: '01012345678',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/^01[0125]\d{8}$/, {
    message:
      'Parent phone must be a valid Egyptian mobile number (e.g., 01012345678)',
  })
  public parent_phone?: string;

  @ApiProperty({
    description: 'Student grade level',
    example: 'Grade 10',
    required: false,
    maxLength: 50,
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  public grade_level?: string;

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
