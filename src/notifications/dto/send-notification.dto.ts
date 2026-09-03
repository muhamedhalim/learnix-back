import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { AdminNotificationCategory } from '../entities/admin-notification-category.enum';
import { NotificationPriority } from '../entities/notification-priority.enum';
import { NotificationType } from '../entities/notification-type.enum';

export class SendNotificationDto {
  @ApiProperty({
    description: 'User ID (UUID) to send notification to',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  public user_id!: string;

  @IsNotEmpty()
  public type!: NotificationType;

  @MaxLength(200)
  public title!: string;

  @IsNotEmpty()
  public message!: string;

  @ApiPropertyOptional({
    description: 'Additional data as JSON (lesson_id, exam_id, etc.)',
    example: { lesson_id: 1, lesson_name: 'Math 101' },
  })
  @IsObject()
  @IsOptional()
  public data?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Whether to send SMS to parent phone',
    default: true,
  })
  @IsOptional()
  public send_sms?: boolean;

  @ApiPropertyOptional({
    enum: NotificationPriority,
    description: 'Set only for admin-facing notifications',
  })
  @IsOptional()
  @IsEnum(NotificationPriority)
  public priority?: NotificationPriority;

  @ApiPropertyOptional({
    enum: AdminNotificationCategory,
    description: 'Set only for admin-facing notifications',
  })
  @IsOptional()
  @IsEnum(AdminNotificationCategory)
  public category?: AdminNotificationCategory;

  @ApiPropertyOptional({
    description: 'Deep link to where the recipient takes action',
    example: '/admin/teachers?status=pending',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public link?: string;
}
