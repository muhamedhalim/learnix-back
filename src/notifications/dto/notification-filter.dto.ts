import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { AdminNotificationCategory } from '../entities/admin-notification-category.enum';
import { NotificationPriority } from '../entities/notification-priority.enum';
import { NotificationType } from '../entities/notification-type.enum';
import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
import { StrictBooleanQuery } from '../../common/decorators/strict-boolean-query.decorator';

export class NotificationFilterDto {
  @ApiPropertyOptional({
    description: 'Page number',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    default: 20,
    minimum: 1,
  })
  @IsOptional()
  @StrictIntegerQuery({ max: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number = 20;

  @ApiPropertyOptional({
    enum: NotificationType,
    description: 'Filter by notification type',
  })
  @IsOptional()
  @IsEnum(NotificationType)
  public type?: NotificationType;

  @ApiPropertyOptional({
    description: 'Filter by read status',
  })
  @StrictBooleanQuery()
  public is_read?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by SMS sent status',
  })
  @StrictBooleanQuery()
  public sms_sent?: boolean;

  @ApiPropertyOptional({
    description: 'Filter notifications sent after this date',
    example: '2025-01-01',
  })
  @IsOptional()
  @IsDateString()
  public sent_after?: string;

  @ApiPropertyOptional({
    description: 'Filter notifications sent before this date',
    example: '2025-12-31',
  })
  @IsOptional()
  @IsDateString()
  public sent_before?: string;

  @ApiPropertyOptional({
    enum: NotificationPriority,
    description: 'Filter by priority (admin notifications only)',
  })
  @IsOptional()
  @IsEnum(NotificationPriority)
  public priority?: NotificationPriority;

  @ApiPropertyOptional({
    enum: AdminNotificationCategory,
    description: 'Filter by category (admin notifications only)',
  })
  @IsOptional()
  @IsEnum(AdminNotificationCategory)
  public category?: AdminNotificationCategory;
}

/**
 * Admin variant of the notification filter: same paging/type/status filters,
 * plus free-text search and an optional per-user narrowing. Used only by the
 * admin-wide listing (`GET /admin/notifications`).
 */
export class AdminNotificationFilterDto extends NotificationFilterDto {
  @ApiPropertyOptional({
    description: 'Only return notifications with failed or unavailable delivery legs',
  })
  @StrictBooleanQuery()
  public needs_attention?: boolean;

  @ApiPropertyOptional({
    description: 'Free-text search across title, message, and recipient name/email',
  })
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional({ description: 'Filter by recipient user id' })
  @IsOptional()
  @IsUUID('4')
  public user_id?: string;
}
