import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduledOneToOneLessons2072000000000 implements MigrationInterface {
  public name = 'AddScheduledOneToOneLessons2072000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "scheduled_lesson_sessions_status_enum" AS ENUM
          ('scheduled', 'cancellation_pending', 'cancelled', 'completed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "lesson_session_bookings_status_enum" AS ENUM
          ('held', 'payment_review', 'confirmed', 'expired', 'failed', 'cancelled', 'refunded');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "scheduled_lesson_sessions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "lesson_id" uuid NOT NULL REFERENCES "lessons"("id") ON DELETE RESTRICT,
        "teacher_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "start_at" timestamptz NOT NULL,
        "end_at" timestamptz NOT NULL,
        "status" "scheduled_lesson_sessions_status_enum" NOT NULL DEFAULT 'scheduled',
        "meeting_url" varchar(2000),
        "cancellation_reason" text,
        "cancellation_requested_at" timestamptz,
        "cancelled_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_scheduled_lesson_sessions_time" CHECK ("end_at" > "start_at"),
        CONSTRAINT "CHK_scheduled_lesson_sessions_https_meeting_url"
          CHECK ("meeting_url" IS NULL OR "meeting_url" ~* '^https://')
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_scheduled_lesson_sessions_lesson_start" ON "scheduled_lesson_sessions" ("lesson_id", "start_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_scheduled_lesson_sessions_teacher_start" ON "scheduled_lesson_sessions" ("teacher_id", "start_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_scheduled_lesson_sessions_status_start" ON "scheduled_lesson_sessions" ("status", "start_at")`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "lesson_session_bookings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "scheduled_session_id" uuid NOT NULL REFERENCES "scheduled_lesson_sessions"("id") ON DELETE RESTRICT,
        "student_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "order_id" uuid UNIQUE REFERENCES "orders"("id") ON DELETE RESTRICT,
        "payment_id" uuid UNIQUE REFERENCES "payments"("id") ON DELETE RESTRICT,
        "status" "lesson_session_bookings_status_enum" NOT NULL,
        "hold_expires_at" timestamptz NOT NULL,
        "price_minor_snapshot" bigint NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'EGP',
        "confirmed_at" timestamptz,
        "expired_at" timestamptz,
        "failed_at" timestamptz,
        "cancelled_at" timestamptz,
        "refunded_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_lesson_session_bookings_session_status" ON "lesson_session_bookings" ("scheduled_session_id", "status")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_lesson_session_bookings_student_created" ON "lesson_session_bookings" ("student_id", "created_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_lesson_session_bookings_hold_expiry" ON "lesson_session_bookings" ("status", "hold_expires_at")`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lesson_session_bookings_one_active"
      ON "lesson_session_bookings" ("scheduled_session_id")
      WHERE "status" IN ('held', 'payment_review', 'confirmed')
    `);

    await q.query(`ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "scheduled_lesson_session_id" uuid`);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "attendance_records"
          ADD CONSTRAINT "FK_attendance_scheduled_lesson_session"
          FOREIGN KEY ("scheduled_lesson_session_id") REFERENCES "scheduled_lesson_sessions"("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`DROP INDEX IF EXISTS "IDX_attendance_student_lesson"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_attendance_legacy_student_lesson"
      ON "attendance_records" ("student_id", "lesson_id")
      WHERE "scheduled_lesson_session_id" IS NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_attendance_student_scheduled_session"
      ON "attendance_records" ("student_id", "scheduled_lesson_session_id")
      WHERE "scheduled_lesson_session_id" IS NOT NULL
    `);

    await q.query(`
      UPDATE "orders" o
      SET "metadata" = COALESCE(o."metadata", '{}'::jsonb) || '{"legacy_individual_purchase":true}'::jsonb
      FROM "lessons" l
      WHERE o."item_type" = 'lesson'
        AND o."item_id" = l."id"
        AND l."is_group" = false
        AND o."status" IN ('awaiting_payment', 'payment_submitted', 'under_review')
    `);
    await q.query(`
      DO $$
      DECLARE affected_count integer;
      BEGIN
        SELECT COUNT(DISTINCT item."package_id") INTO affected_count
        FROM "lesson_package_items" item
        JOIN "lessons" lesson ON lesson."id" = item."lesson_id"
        WHERE lesson."is_group" = false;
        RAISE NOTICE 'scheduled one-to-one migration: % packages contain Individual lessons and are blocked from new sales until remediated', affected_count;
      END $$
    `);
    await q.query(`
      DO $$
      DECLARE affected_count integer;
      BEGIN
        SELECT COUNT(*) INTO affected_count
        FROM "attendance_codes" code
        JOIN "lessons" lesson ON lesson."id" = code."item_id"
        WHERE code."type" = 'lesson'
          AND lesson."is_group" = false
          AND code."status" = 'unused';
        RAISE NOTICE 'scheduled one-to-one migration: % unused codes target Individual lessons and are blocked from redemption until remediated', affected_count;
      END $$
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_attendance_student_scheduled_session"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_attendance_legacy_student_lesson"`);
    await q.query(`ALTER TABLE "attendance_records" DROP CONSTRAINT IF EXISTS "FK_attendance_scheduled_lesson_session"`);
    await q.query(`ALTER TABLE "attendance_records" DROP COLUMN IF EXISTS "scheduled_lesson_session_id"`);
    await q.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM "attendance_records"
          GROUP BY "student_id", "lesson_id"
          HAVING COUNT(*) > 1
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS "IDX_attendance_student_lesson"
          ON "attendance_records" ("student_id", "lesson_id");
        END IF;
      END $$
    `);
    await q.query(`DROP TABLE IF EXISTS "lesson_session_bookings"`);
    await q.query(`DROP TABLE IF EXISTS "scheduled_lesson_sessions"`);
    await q.query(`DROP TYPE IF EXISTS "lesson_session_bookings_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "scheduled_lesson_sessions_status_enum"`);
  }
}
