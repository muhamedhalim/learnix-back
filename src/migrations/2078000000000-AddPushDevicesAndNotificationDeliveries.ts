import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-005 — Push transport storage.
 *
 * Adds the two tables the push channel needs and nothing else. Purely additive:
 * no existing table, column, index or row is touched, so an instance running
 * the previous build against this schema is unaffected and the migration is
 * safe to apply ahead of the deployment that uses it.
 *
 *  - `push_devices` — one row per (provider, registration token). A user has
 *    many. Two uniqueness rules, for two different reasons:
 *      * `UQ_push_devices_provider_token`: a token identifies exactly one
 *        install globally, so a second user registering the same token
 *        reassigns ownership instead of creating a duplicate delivery target.
 *      * `UQ_push_devices_user_device` (partial): FCM rotates tokens, and a
 *        client that reports a stable device id must update its row rather than
 *        leave a trail of dead ones. Partial because `device_id` is optional
 *        and NULLs do not conflict in a plain unique index.
 *    `IDX_push_devices_user_enabled` is partial on `enabled = true` because the
 *    dispatcher only ever asks for a user's *active* devices.
 *
 *  - `notification_deliveries` — the per-channel leg of an existing
 *    `notifications` row, joined by `notification_id`, so push/email/SMS
 *    outcomes land inside the notification history that already exists rather
 *    than in a parallel system. `dedupe_key` is UNIQUE and is what makes a
 *    BullMQ retry idempotent (claim-before-send).
 */
export class AddPushDevicesAndNotificationDeliveries2078000000000 implements MigrationInterface {
  public name = 'AddPushDevicesAndNotificationDeliveries2078000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "push_devices_provider_enum" AS ENUM ('fcm');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "push_devices_platform_enum" AS ENUM ('web', 'android', 'ios');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "push_devices_disabled_reason_enum" AS ENUM
          ('user_revoked', 'invalid_token', 'reassigned');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "push_devices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "provider" "push_devices_provider_enum" NOT NULL DEFAULT 'fcm',
        "token" text NOT NULL,
        "platform" "push_devices_platform_enum" NOT NULL DEFAULT 'web',
        "device_id" character varying(200),
        "device_label" character varying(200),
        "enabled" boolean NOT NULL DEFAULT true,
        "revoked_at" timestamptz,
        "disabled_reason" "push_devices_disabled_reason_enum",
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "last_success_at" timestamptz,
        "failure_count" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_push_devices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_push_devices_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_push_devices_user" ON "push_devices" ("user_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_push_devices_user_enabled"
         ON "push_devices" ("user_id") WHERE "enabled" = true`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_devices_provider_token"
         ON "push_devices" ("provider", "token")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_devices_user_device"
         ON "push_devices" ("user_id", "provider", "device_id")
         WHERE "device_id" IS NOT NULL`,
    );

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "notification_deliveries_channel_enum" AS ENUM ('sms', 'email', 'push');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "notification_deliveries_status_enum" AS ENUM (
          'queued', 'sent', 'failed', 'skipped_preference',
          'no_registered_device', 'invalid_token', 'provider_unavailable'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "notification_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "dedupe_key" character varying(200) NOT NULL,
        "notification_id" uuid NOT NULL,
        "channel" "notification_deliveries_channel_enum" NOT NULL,
        "status" "notification_deliveries_status_enum" NOT NULL DEFAULT 'queued',
        "provider" character varying(40),
        "push_device_id" uuid,
        "provider_message_id" character varying(300),
        "attempts" integer NOT NULL DEFAULT 0,
        "error_message" text,
        "sent_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notification_deliveries_notification" FOREIGN KEY ("notification_id")
          REFERENCES "notifications"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notification_deliveries_push_device" FOREIGN KEY ("push_device_id")
          REFERENCES "push_devices"("id") ON DELETE SET NULL
      )
    `);

    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notification_deliveries_dedupe_key"
         ON "notification_deliveries" ("dedupe_key")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_deliveries_notification"
         ON "notification_deliveries" ("notification_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_deliveries_status"
         ON "notification_deliveries" ("status")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_deliveries_channel"
         ON "notification_deliveries" ("channel")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "notification_deliveries"`);
    await q.query(`DROP TYPE IF EXISTS "notification_deliveries_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "notification_deliveries_channel_enum"`);
    await q.query(`DROP TABLE IF EXISTS "push_devices"`);
    await q.query(`DROP TYPE IF EXISTS "push_devices_disabled_reason_enum"`);
    await q.query(`DROP TYPE IF EXISTS "push_devices_platform_enum"`);
    await q.query(`DROP TYPE IF EXISTS "push_devices_provider_enum"`);
  }
}
