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
  @Matches(/^01[0125][0-9]{8}$/, {
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
}

export class UpdateStudentNotificationSettingsDto {
  @IsObject()
  public notification_settings!: Record<string, boolean>;
}
