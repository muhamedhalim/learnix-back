import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationStatusTracking1768621000000 implements MigrationInterface {
  public name = 'AddNotificationStatusTracking1768621000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create the notification_status enum if it doesn't exist
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status_enum') THEN
          CREATE TYPE "notification_status_enum" AS ENUM ('pending', 'sent', 'delivered', 'failed');
        END IF;
      END$$;
    `);

    // Add status column
    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD COLUMN IF NOT EXISTS "status" "notification_status_enum" NOT NULL DEFAULT 'pending'
    `);

    // Add attempts column
    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0
    `);

    // Add error_message column
    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD COLUMN IF NOT EXISTS "error_message" text
    `);

    // Add delivered_at column
    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMP WITH TIME ZONE
    `);

    // Add index for status filtering
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_status"
      ON "notifications" ("status")
    `);

    // Update existing notifications: mark as delivered if sms_sent=true, otherwise sent
    // Only run this if the old columns exist (for migrating existing data)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'notifications' AND column_name = 'sms_sent'
        ) THEN
          UPDATE "notifications"
          SET "status" = CASE
            WHEN "sms_sent" = true THEN 'delivered'::"notification_status_enum"
            ELSE 'sent'::"notification_status_enum"
          END,
          "attempts" = 1,
          "delivered_at" = CASE
            WHEN "sms_sent" = true THEN "sent_at"
            ELSE NULL
          END
          WHERE "status" = 'pending'::"notification_status_enum";
        END IF;
      END$$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove index
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_notifications_status"
    `);

    // Remove columns
    await queryRunner.query(`
      ALTER TABLE "notifications"
      DROP COLUMN IF EXISTS "status",
      DROP COLUMN IF EXISTS "attempts",
      DROP COLUMN IF EXISTS "error_message",
      DROP COLUMN IF EXISTS "delivered_at"
    `);

    // Note: We don't drop the enum type as it might be used elsewhere
  }
}
