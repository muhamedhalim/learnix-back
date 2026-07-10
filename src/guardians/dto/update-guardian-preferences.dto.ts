import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, Length } from 'class-validator';

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { GuardianRelationship, PreferredLanguage } from '../entities';
import { IsParentNotificationPreferenceMap } from './is-parent-notification-preference-map.validator';

export class UpdateGuardianPreferencesDto {
  @ApiPropertyOptional({ description: 'Master switch for this student↔guardian pairing.' })
  @IsOptional()
  @IsBoolean()
  public receives_notifications?: boolean;

  @ApiPropertyOptional({ enum: GuardianRelationship })
  @IsOptional()
  @IsEnum(GuardianRelationship)
  public relationship?: GuardianRelationship;

  @ApiPropertyOptional({
    description:
      'Sparse per-event overrides, e.g. `{"exam_graded": true, "lesson_completed": false}`. Keys must be known event types and values must be booleans; anything else is a 400.',
    example: { exam_graded: true, attendance_marked: false },
  })
  @IsOptional()
  @IsObject()
  @IsParentNotificationPreferenceMap()
  public notification_preferences?: Partial<Record<ParentEventType, boolean>>;
}

export class UpdateGuardianProfileDto {
  @ApiPropertyOptional({ example: 'أحمد محمود' })
  @IsOptional()
  @IsString()
  @Length(2, 150)
  public full_name?: string;

  @ApiPropertyOptional({ enum: PreferredLanguage })
  @IsOptional()
  @IsEnum(PreferredLanguage)
  public preferred_language?: PreferredLanguage;
}
