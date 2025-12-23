import {
  IsNotEmpty,
  IsString,
  IsEnum,
  IsOptional,
  IsInt,
  IsObject,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '../entities/notification-type.enum';

export class SendNotificationDto {
  @ApiProperty({ description: 'User ID to send notification to' })
  @IsInt()
  @IsNotEmpty()
  user_id!: number;

  @ApiProperty({
    enum: NotificationType,
    description: 'Type of notification',
  })
  @IsEnum(NotificationType)
  @IsNotEmpty()
  type!: NotificationType;

  @ApiProperty({
    description: 'Notification title',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    description: 'Notification message body',
  })
  @IsString()
  @IsNotEmpty()
  message!: string;

  @ApiPropertyOptional({
    description: 'Additional data as JSON (lesson_id, exam_id, etc.)',
    example: { lesson_id: 1, lesson_name: 'Math 101' },
  })
  @IsObject()
  @IsOptional()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Whether to send SMS to parent phone',
    default: true,
  })
  @IsOptional()
  send_sms?: boolean;
}
