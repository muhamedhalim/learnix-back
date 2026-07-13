import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the remaining `notifications`/`notification_settings` drift not
 * covered by `ConvertNotificationTypeToEnum1789999999000`.
 *
 * `notifications.metadata` (jsonb) is renamed to `data` — same purpose,
 * same type, just renamed when the entity was redesigned; preserved rather
 * than dropped+recreated. `sent_at`, `read_at`, `sms_sent`, `sms_to` have no
 * prior equivalent. `sent_at` is `NOT NULL` on the entity but never existed
 * before, so existing rows backfill from `created_at` (the closest known
 * timestamp) before the constraint is applied.
 *
 * `notification_settings` gains the four granular per-event booleans that
 * replaced the old single `notification_types` jsonb blob (left in place,
 * unmapped — its exact historical shape was never documented, so this does
 * not attempt to parse and migrate it; each user's four settings simply
 * start at the entity's own sensible defaults).
 */
export class FixNotificationsColumns1820000003000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notifications" RENAME COLUMN "metadata" TO "data"`);

    await q.query(`ALTER TABLE "notifications" ADD COLUMN "sent_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`UPDATE "notifications" SET "sent_at" = "created_at"`);
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "sent_at" SET NOT NULL`);

    await q.query(`ALTER TABLE "notifications" ADD COLUMN "read_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "sms_sent" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "sms_to" character varying(20)`);

    await q.query(`UPDATE "notifications" SET "is_read" = false WHERE "is_read" IS NULL`);
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "is_read" SET NOT NULL`);

    await q.query(
      `ALTER TABLE "notification_settings" ADD COLUMN "notify_parent_on_attendance" boolean NOT NULL DEFAULT true`,
    );
    await q.query(
      `ALTER TABLE "notification_settings" ADD COLUMN "notify_parent_on_exam_grade" boolean NOT NULL DEFAULT true`,
    );
    await q.query(
      `ALTER TABLE "notification_settings" ADD COLUMN "notify_parent_on_lesson_expiry" boolean NOT NULL DEFAULT true`,
    );
    await q.query(
      `ALTER TABLE "notification_settings" ADD COLUMN "notify_on_purchase" boolean NOT NULL DEFAULT true`,
    );

    await q.query(`UPDATE "notification_settings" SET "sms_enabled" = true WHERE "sms_enabled" IS NULL`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "sms_enabled" SET NOT NULL`);
    await q.query(`UPDATE "notification_settings" SET "email_enabled" = false WHERE "email_enabled" IS NULL`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "email_enabled" SET DEFAULT false`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "email_enabled" SET NOT NULL`);
    await q.query(`UPDATE "notification_settings" SET "push_enabled" = false WHERE "push_enabled" IS NULL`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "push_enabled" SET DEFAULT false`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "push_enabled" SET NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "push_enabled" DROP NOT NULL`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "push_enabled" DROP DEFAULT`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "email_enabled" DROP NOT NULL`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "email_enabled" DROP DEFAULT`);
    await q.query(`ALTER TABLE "notification_settings" ALTER COLUMN "sms_enabled" DROP NOT NULL`);

    await q.query(`ALTER TABLE "notification_settings" DROP COLUMN "notify_on_purchase"`);
    await q.query(`ALTER TABLE "notification_settings" DROP COLUMN "notify_parent_on_lesson_expiry"`);
    await q.query(`ALTER TABLE "notification_settings" DROP COLUMN "notify_parent_on_exam_grade"`);
    await q.query(`ALTER TABLE "notification_settings" DROP COLUMN "notify_parent_on_attendance"`);

    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "is_read" DROP NOT NULL`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "sms_to"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "sms_sent"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "read_at"`);
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "sent_at" DROP NOT NULL`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "sent_at"`);

    await q.query(`ALTER TABLE "notifications" RENAME COLUMN "data" TO "metadata"`);
  }
}
