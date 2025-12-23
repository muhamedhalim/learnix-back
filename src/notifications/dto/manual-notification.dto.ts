import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  IsBoolean,
  MaxLength,
  ArrayMinSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ManualNotificationDto {
  @ApiProperty({
    description: 'Notification title',
    maxLength: 200,
    example: 'Important Announcement',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    description: 'Notification message body',
    example: 'Reminder: Exams start next week. Good luck!',
  })
  @IsString()
  @IsNotEmpty()
  message!: string;

  @ApiPropertyOptional({
    description:
      'Specific user IDs to send to (if not provided, sends to all students)',
    example: [1, 2, 3],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @ArrayMinSize(1)
  user_ids?: number[];

  @ApiPropertyOptional({
    description: 'Send SMS along with in-app notification',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  send_sms?: boolean;
}

export class ManualNotificationResponseDto {
  @ApiProperty({
    description: 'Number of notifications sent',
    example: 50,
  })
  sent_count!: number;

  @ApiProperty({
    description: 'Number of SMS messages sent',
    example: 45,
  })
  sms_sent_count!: number;

  @ApiProperty({
    description: 'Number of SMS failures (no phone number or disabled)',
    example: 5,
  })
  sms_failed_count!: number;
}
