import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({
    description: 'Enable SMS notifications',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  public sms_enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Enable email notifications (future)',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  public email_enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Enable push notifications (future)',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  public push_enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Override parent phone number for SMS (Egyptian format)',
    example: '01012345678',
  })
  @IsString()
  @IsOptional()
  @Matches(/^01[0125][0-9]{8}$/, {
    message: 'Phone must be a valid Egyptian mobile number (e.g., 01012345678)',
  })
  public parent_phone_override?: string;

  @ApiPropertyOptional({
    description: 'Notify parent on attendance events',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  public notify_parent_on_attendance?: boolean;

  @ApiPropertyOptional({
    description: 'Notify parent when exam is graded',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  public notify_parent_on_exam_grade?: boolean;

  @ApiPropertyOptional({
    description: 'Notify parent when lesson access is about to expire',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  public notify_parent_on_lesson_expiry?: boolean;

  @ApiPropertyOptional({
    description: 'Notify on successful purchase',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  public notify_on_purchase?: boolean;
}
