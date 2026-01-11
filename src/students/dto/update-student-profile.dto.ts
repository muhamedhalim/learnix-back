import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  MaxLength,
  Matches,
  IsObject,
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
  parent_phone?: string;

  @ApiProperty({
    description: 'Student grade level',
    example: 'Grade 10',
    required: false,
    maxLength: 50,
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  grade_level?: string;
}

export class UpdateStudentNotificationSettingsDto {
  @ApiProperty({
    description: 'Notification settings as key-value pairs',
    example: {
      sms_enabled: true,
      email_enabled: true,
      lesson_reminders: true,
      exam_results: true,
      payment_notifications: true,
    },
    required: true,
  })
  @IsObject()
  notification_settings!: Record<string, boolean>;
}
