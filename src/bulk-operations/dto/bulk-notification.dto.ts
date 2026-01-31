import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Filter options for selecting notification recipients
 */
export class NotificationFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by grade level (1-12)',
    example: '10',
  })
  @IsOptional()
  @IsString()
  public grade_level?: string;

  @ApiPropertyOptional({
    description: 'Filter by subject ID',
    example: 'uuid-here',
  })
  @IsOptional()
  @IsUUID()
  public subject_id?: string;

  @ApiPropertyOptional({
    description: 'Filter by student status',
    enum: ['active', 'suspended', 'all'],
    example: 'active',
  })
  @IsOptional()
  @IsString()
  public status?: 'active' | 'suspended' | 'all';

  @ApiPropertyOptional({
    description: 'Filter by specific student IDs',
    type: [String],
  })
  @IsOptional()
  @IsArray()
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

  @ApiProperty({
    description: 'Filter criteria for selecting recipients',
    type: NotificationFilterDto,
  })
  public filter!: NotificationFilterDto;
}

/**
 * Response DTO for bulk notification operation
 */
export class BulkNotificationResultDto {
  @ApiProperty({ description: 'Total notifications queued' })
  public total_queued!: number;

  @ApiProperty({ description: 'Successfully sent count' })
  public sent_count!: number;

  @ApiProperty({ description: 'Failed count' })
  public failed_count!: number;

  @ApiProperty({ description: 'Skipped (no parent phone) count' })
  public skipped_count!: number;

  @ApiProperty({
    description: 'Job ID for tracking (if async)',
  })
  public job_id?: string;

  @ApiProperty({
    description: 'Processing status',
    enum: ['processing', 'completed'],
  })
  public status!: 'processing' | 'completed';

  @ApiProperty({
    description: 'Started at timestamp',
  })
  public started_at!: Date;

  @ApiPropertyOptional({
    description: 'Completed at timestamp (if finished)',
  })
  public completed_at?: Date;
}
