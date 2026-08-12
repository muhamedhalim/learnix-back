import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

import {
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsDefined,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
  ArrayMaxSize,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Filter options for selecting notification recipients
 */
export class NotificationFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by specific student IDs',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  public student_ids?: string[];
}

/**
 * DTO for bulk notification request
 */
export class BulkNotificationDto {
  @ApiProperty({
    description: 'Notification message',
    example: 'New exam available for your course!',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  public message!: string;

  @ApiPropertyOptional({
    description: 'Notification title',
    example: 'New Exam Alert',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public title?: string;

  @ApiPropertyOptional({ description: 'Arabic notification message', maxLength: 500 })
  @ValidateIf((dto: BulkNotificationDto) => dto.title_ar !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  public message_ar?: string;

  @ApiPropertyOptional({ description: 'Arabic notification title', maxLength: 100 })
  @ValidateIf((dto: BulkNotificationDto) => dto.message_ar !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  public title_ar?: string;

  @ApiProperty({
    description: 'Filter criteria for selecting recipients',
    type: NotificationFilterDto,
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => NotificationFilterDto)
  public filter!: NotificationFilterDto;
}

/**
 * Response DTO for bulk notification operation
 */
export class BulkNotificationResultDto {
  @ApiProperty({ description: 'Durable notification campaign ID' })
  public campaign_id!: string;
  @ApiProperty({ description: 'Total notifications queued' })
  public total_queued!: number;

  @ApiProperty({ description: 'In-app rows created so far' })
  public sent_count!: number;

  @ApiProperty({ description: 'Failed count' })
  public failed_count!: number;

  @ApiProperty({ description: 'Skipped recipient count' })
  public skipped_count!: number;

  @ApiProperty({
    description: 'Job ID for tracking (if async)',
  })
  public job_id?: string;

  @ApiProperty({
    description: 'Processing status',
    enum: ['queued', 'processing', 'completed', 'partially_failed', 'failed'],
  })
  public status!: 'queued' | 'processing' | 'completed' | 'partially_failed' | 'failed';

  @ApiProperty({
    description: 'Started at timestamp',
  })
  public started_at!: Date;

  @ApiPropertyOptional({
    description: 'Completed at timestamp (if finished)',
  })
  public completed_at?: Date;
}
