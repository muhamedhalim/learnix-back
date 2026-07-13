import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restores `notification_settings.parent_phone_override` immediately before
 * `CreateGuardianSystem1800000000000`, which reads it as one of three legacy
 * phone sources during its guardian backfill, then deliberately drops it at
 * the end of the same migration.
 *
 * `InitialSchema1734986400000` never created this column — `notification_settings`
 * there has only `email_enabled`, `sms_enabled`, `push_enabled`,
 * `notification_types`. `CreateGuardianSystem` was written and tested against
 * a database where this column already existed (via `synchronize`, in
 * whatever environment authored it), the same drift pattern behind the
 * `payments.user_id` and `notifications.type` gaps.
 *
 * Unlike those two, the current `NotificationSettings` entity does NOT want
 * this column back — its own comment documents that `parent_phone_override`
 * was intentionally removed ("was a hole in exactly that rule": it let a
 * guardian phone be overridden without the OTP verification the guardian
 * system now enforces). So this migration doesn't reintroduce a real,
 * ongoing column — it only adds the transient placeholder
 * `CreateGuardianSystem` expects to find and immediately delete. No backfill
 * is needed: the column never existed before, so every row is legitimately
 * NULL, and `CreateGuardianSystem`'s `COALESCE` correctly falls through to
 * `student_profiles.parent_phone` / `users.parent_phone` for those rows.
 */
export class AddNotificationSettingsParentPhoneOverride1799999999000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "notification_settings" ADD COLUMN "parent_phone_override" character varying(20)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "parent_phone_override"`,
    );
  }
}
