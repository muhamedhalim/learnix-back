import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export enum ManualNotificationAudience {
  ALL_ACTIVE_STUDENTS = 'all_active_students',
  USER_IDS = 'user_ids',
}

export class ManualNotificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  public title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  public message!: string;

  @ApiPropertyOptional({ description: 'Arabic title; must be supplied with message_ar' })
  @ValidateIf((dto: ManualNotificationDto) => dto.message_ar !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  public title_ar?: string;

  @ApiPropertyOptional({ description: 'Arabic body; must be supplied with title_ar' })
  @ValidateIf((dto: ManualNotificationDto) => dto.title_ar !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  public message_ar?: string;

  @ApiPropertyOptional({
    enum: ManualNotificationAudience,
    default: ManualNotificationAudience.ALL_ACTIVE_STUDENTS,
  })
  @IsOptional()
  @IsEnum(ManualNotificationAudience)
  public audience?: ManualNotificationAudience;

  @ApiPropertyOptional({
    description:
      'Specific user IDs (UUIDs) to send to (if not provided, sends to all students)',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  public user_ids?: string[];
}

export class ManualNotificationResponseDto {
  @ApiProperty({ description: 'Durable campaign identifier' })
  public campaign_id!: string;

  @ApiProperty({ description: 'Number of intended recipients' })
  public intended_count!: number;

  @ApiProperty({ enum: ['queued', 'processing', 'completed', 'partially_failed', 'failed'] })
  public status!: string;
}
