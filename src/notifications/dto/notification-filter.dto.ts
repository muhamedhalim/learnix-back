import {
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  Min,
  IsDateString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { NotificationType } from '../entities/notification-type.enum';

export class NotificationFilterDto {
  @ApiPropertyOptional({
    description: 'Page number',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    default: 20,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  @ApiPropertyOptional({
    enum: NotificationType,
    description: 'Filter by notification type',
  })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({
    description: 'Filter by read status',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  is_read?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by SMS sent status',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  sms_sent?: boolean;

  @ApiPropertyOptional({
    description: 'Filter notifications sent after this date',
    example: '2025-01-01',
  })
  @IsOptional()
  @IsDateString()
  sent_after?: string;

  @ApiPropertyOptional({
    description: 'Filter notifications sent before this date',
    example: '2025-12-31',
  })
  @IsOptional()
  @IsDateString()
  sent_before?: string;
}
