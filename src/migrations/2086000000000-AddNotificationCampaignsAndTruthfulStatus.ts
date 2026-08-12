import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationCampaignsAndTruthfulStatus2086000000000
  implements MigrationInterface
{
  name = 'AddNotificationCampaignsAndTruthfulStatus2086000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE "notification_campaigns_origin_enum" AS ENUM ('legacy_unknown', 'admin_manual', 'teacher_manual', 'system', 'operational')`,
    );
    await q.query(
      `CREATE TYPE "notification_campaigns_status_enum" AS ENUM ('queued', 'processing', 'completed', 'partially_failed', 'failed')`,
    );
    await q.query(
      `CREATE TYPE "notifications_origin_enum" AS ENUM ('legacy_unknown', 'admin_manual', 'teacher_manual', 'system', 'operational')`,
    );
    await q.query(`
      CREATE TABLE "notification_campaigns" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "idempotency_key" varchar(180) NOT NULL,
        "created_by_user_id" uuid,
        "origin" "notification_campaigns_origin_enum" NOT NULL DEFAULT 'admin_manual',
        "status" "notification_campaigns_status_enum" NOT NULL DEFAULT 'queued',
        "title_en" varchar(200) NOT NULL,
        "message_en" text NOT NULL,
        "title_ar" varchar(200),
        "message_ar" text,
        "audience" jsonb NOT NULL,
        "requested_channels" jsonb NOT NULL DEFAULT '["in_app","push"]'::jsonb,
        "intended_count" integer NOT NULL DEFAULT 0,
        "created_count" integer NOT NULL DEFAULT 0,
        "failed_count" integer NOT NULL DEFAULT 0,
        "error_message" text,
        "queued_at" timestamptz,
        "started_at" timestamptz,
        "completed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_campaigns" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_notification_campaigns_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "FK_notification_campaigns_creator" FOREIGN KEY ("created_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_notification_campaigns_status_created" ON "notification_campaigns" ("status", "created_at")`,
    );
    await q.query(
      `CREATE INDEX "IDX_notification_campaigns_creator" ON "notification_campaigns" ("created_by_user_id")`,
    );

    await q.query(`ALTER TABLE "notifications" ADD COLUMN "campaign_id" uuid`);
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "created_by_user_id" uuid`);
    await q.query(
      `ALTER TABLE "notifications" ADD COLUMN "origin" "notifications_origin_enum" NOT NULL DEFAULT 'legacy_unknown'`,
    );
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "source_event" varchar(120)`);
    await q.query(
      `ALTER TABLE "notification_deliveries" ADD COLUMN "request_payload" jsonb`,
    );
    await q.query(`
      ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_campaign"
      FOREIGN KEY ("campaign_id") REFERENCES "notification_campaigns"("id") ON DELETE SET NULL
    `);
    await q.query(`
      ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_creator"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    await q.query(
      `CREATE UNIQUE INDEX "IDX_notifications_campaign_user" ON "notifications" ("campaign_id", "user_id") WHERE "campaign_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX "IDX_notifications_origin_sent" ON "notifications" ("origin", "sent_at" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_sent_id" ON "notifications" ("sent_at" DESC, "id" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_user_read_sent" ON "notifications" ("user_id", "is_read", "sent_at" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_type_sent" ON "notifications" ("type", "sent_at" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_title_trgm" ON "notifications" USING GIN ("title" gin_trgm_ops)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_message_trgm" ON "notifications" USING GIN ("message" gin_trgm_ops)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_deliveries_status_created" ON "notification_deliveries" ("status", "created_at" DESC)`,
    );

    // Existing rows are already visible in-app. `pending` was not a real
    // provider state, so normalise it to the truthful local publication state.
    await q.query(`UPDATE "notifications" SET "status" = 'sent' WHERE "status" = 'pending'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_notification_deliveries_status_created"`);
    await q.query(
      `ALTER TABLE "notification_deliveries" DROP COLUMN IF EXISTS "request_payload"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_type_sent"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_message_trgm"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_title_trgm"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_user_read_sent"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_sent_id"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_origin_sent"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_campaign_user"`);
    await q.query(`ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "FK_notifications_creator"`);
    await q.query(`ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "FK_notifications_campaign"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "source_event"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "origin"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "created_by_user_id"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "campaign_id"`);
    await q.query(`DROP TABLE IF EXISTS "notification_campaigns"`);
    await q.query(`DROP TYPE IF EXISTS "notifications_origin_enum"`);
    await q.query(`DROP TYPE IF EXISTS "notification_campaigns_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "notification_campaigns_origin_enum"`);
  }
}
