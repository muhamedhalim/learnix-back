import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsNotEmpty, IsObject, IsOptional, MaxLength } from 'class-validator';

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
}
