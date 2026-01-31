import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class ManualNotificationDto {
  @MaxLength(200)
  public title!: string;

  @IsNotEmpty()
  public message!: string;

  @ApiPropertyOptional({
    description:
      'Specific user IDs (UUIDs) to send to (if not provided, sends to all students)',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  public user_ids?: string[];

  @ApiPropertyOptional({
    description: 'Send SMS along with in-app notification',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  public send_sms?: boolean;
}

export class ManualNotificationResponseDto {
  @ApiProperty({
    description: 'Number of notifications sent',
    example: 50,
  })
  public sent_count!: number;

  @ApiProperty({
    description: 'Number of SMS messages sent',
    example: 45,
  })
  public sms_sent_count!: number;

  @ApiProperty({
    description: 'Number of SMS failures (no phone number or disabled)',
    example: 5,
  })
  public sms_failed_count!: number;
}
