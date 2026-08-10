import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Channel preferences only. This DTO is the write side of
 * `NotificationChannelPolicyService`, which is the single thing every sender
 * consults before touching a provider — so a field here either changes real
 * delivery behaviour or is explicitly marked dead below.
 */
export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({
    description:
      'Enable SMS notifications. When false, no SMS is dispatched for this user — ' +
      'including the guardian fan-out, which this flag has always gated.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  public sms_enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Enable optional notification email. Does NOT affect transactional or security ' +
      'mail (password reset, login verification, invoices, operational alerts).',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  public email_enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Enable push notifications. Requires at least one registered push device ' +
      '(POST /notifications/push/devices) before anything can be delivered.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  public push_enabled?: boolean;

  // `parent_phone_override` removed: it let a student redirect parent SMS to an
  // arbitrary number, bypassing guardian verification entirely.

  /* ------------------------------------------------------------------ *
   * DEPRECATED — accepted, validated, and deliberately IGNORED.
   *
   * These four duplicated `student_guardians.notification_preferences`, which
   * is the only model the guardian dispatcher has ever read. Migration
   * 2079000000000 reconciled their values into the guardian links and dropped
   * the columns; guardian events are now edited per guardian through
   * `PUT /student/guardians/:guardianId/preferences`.
   *
   * They remain in the DTO for exactly one release so that a frontend build
   * deployed before the backend — which still PUTs all seven fields — receives
   * a 200 instead of a 400 from `forbidNonWhitelisted: true`. Remove them once
   * no deployed client sends them.
   * ------------------------------------------------------------------ */

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'DEPRECATED and ignored. Use PUT /student/guardians/:guardianId/preferences ' +
      'with notification_preferences.attendance_marked.',
  })
  @IsBoolean()
  @IsOptional()
  public notify_parent_on_attendance?: boolean;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'DEPRECATED and ignored. Use PUT /student/guardians/:guardianId/preferences ' +
      'with notification_preferences.exam_graded.',
  })
  @IsBoolean()
  @IsOptional()
  public notify_parent_on_exam_grade?: boolean;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'DEPRECATED and ignored. No lesson-expiry guardian event exists; this flag ' +
      'never suppressed a message.',
  })
  @IsBoolean()
  @IsOptional()
  public notify_parent_on_lesson_expiry?: boolean;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'DEPRECATED and ignored. Use PUT /student/guardians/:guardianId/preferences ' +
      'with notification_preferences.course_purchased.',
  })
  @IsBoolean()
  @IsOptional()
  public notify_on_purchase?: boolean;
}
