import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise batch management for attendance codes (additive + backfill).
 *
 * - `code_batches`: groups codes generated together with shared metadata and
 *   async generation progress.
 * - `attendance_code_audits`: immutable audit trail per code / batch action.
 * - `attendance_codes`: gains `batch_id`, a canonical `status` lifecycle enum,
 *   and revoke metadata. Existing `is_used` / `is_active` are kept for
 *   backward compatibility; `status` is backfilled from them.
 */
export class AddCodeBatchManagement1768660000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    // ---- enums -------------------------------------------------------------
    // Dedicated type for code_batches.type (Postgres enum types are global, so
    // we avoid reusing the attendance_codes column type). Values mirror
    // AttendanceCodeType.
    await q.query(
      `CREATE TYPE "code_batches_type_enum" AS ENUM ('lesson','package','book')`,
    );
    await q.query(
      `CREATE TYPE "code_batch_status_enum" AS ENUM ('pending','processing','completed','failed')`,
    );
    await q.query(
      `CREATE TYPE "attendance_code_status_enum" AS ENUM ('unused','redeemed','expired','revoked')`,
    );
    await q.query(
      `CREATE TYPE "attendance_code_audit_action_enum" AS ENUM ('generated','redeemed','revoked','enabled','disabled','deleted','expired','exported')`,
    );

    // ---- code_batches ------------------------------------------------------
    await q.query(
      `CREATE TABLE "code_batches" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "name" character varying(200) NOT NULL,
         "type" "code_batches_type_enum" NOT NULL,
         "item_id" uuid NOT NULL,
         "requested_count" integer NOT NULL,
         "generated_count" integer NOT NULL DEFAULT 0,
         "status" "code_batch_status_enum" NOT NULL DEFAULT 'pending',
         "error_message" text,
         "expires_at" timestamptz NOT NULL,
         "created_by" uuid NOT NULL,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         "updated_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "PK_code_batches" PRIMARY KEY ("id"),
         CONSTRAINT "FK_code_batches_creator" FOREIGN KEY ("created_by")
           REFERENCES "users"("id") ON DELETE CASCADE
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_code_batches_created_by" ON "code_batches" ("created_by")`,
    );
    await q.query(
      `CREATE INDEX "IDX_code_batches_status" ON "code_batches" ("status")`,
    );
    await q.query(
      `CREATE INDEX "IDX_code_batches_type_item" ON "code_batches" ("type","item_id")`,
    );

    // ---- attendance_codes: new columns ------------------------------------
    await q.query(
      `ALTER TABLE "attendance_codes"
         ADD COLUMN "batch_id" uuid,
         ADD COLUMN "status" "attendance_code_status_enum" NOT NULL DEFAULT 'unused',
         ADD COLUMN "revoked_at" timestamptz,
         ADD COLUMN "revoked_by" uuid,
         ADD COLUMN "revoke_reason" text`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes"
         ADD CONSTRAINT "FK_attendance_codes_batch" FOREIGN KEY ("batch_id")
           REFERENCES "code_batches"("id") ON DELETE CASCADE`,
    );

    // Backfill the lifecycle status from the legacy boolean flags.
    await q.query(
      `UPDATE "attendance_codes" SET "status" = CASE
         WHEN "is_used" = true THEN 'redeemed'::"attendance_code_status_enum"
         WHEN "is_active" = false THEN 'revoked'::"attendance_code_status_enum"
         WHEN "expires_at" < now() THEN 'expired'::"attendance_code_status_enum"
         ELSE 'unused'::"attendance_code_status_enum"
       END`,
    );

    await q.query(
      `CREATE INDEX "IDX_attendance_codes_status" ON "attendance_codes" ("status")`,
    );
    await q.query(
      `CREATE INDEX "IDX_attendance_codes_batch_id" ON "attendance_codes" ("batch_id")`,
    );

    // ---- attendance_code_audits -------------------------------------------
    await q.query(
      `CREATE TABLE "attendance_code_audits" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "code_id" uuid,
         "batch_id" uuid,
         "action" "attendance_code_audit_action_enum" NOT NULL,
         "actor_id" uuid,
         "metadata" jsonb,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "PK_attendance_code_audits" PRIMARY KEY ("id"),
         CONSTRAINT "FK_code_audits_actor" FOREIGN KEY ("actor_id")
           REFERENCES "users"("id") ON DELETE SET NULL
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_code_audits_code_id" ON "attendance_code_audits" ("code_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_code_audits_batch_id" ON "attendance_code_audits" ("batch_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_code_audits_action" ON "attendance_code_audits" ("action")`,
    );
    await q.query(
      `CREATE INDEX "IDX_code_audits_created_at" ON "attendance_code_audits" ("created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "attendance_code_audits"`);
    await q.query(`DROP TYPE IF EXISTS "code_batches_type_enum"`);
    await q.query(
      `DROP INDEX IF EXISTS "IDX_attendance_codes_batch_id"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_attendance_codes_status"`);
    await q.query(
      `ALTER TABLE "attendance_codes"
         DROP CONSTRAINT IF EXISTS "FK_attendance_codes_batch"`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes"
         DROP COLUMN IF EXISTS "revoke_reason",
         DROP COLUMN IF EXISTS "revoked_by",
         DROP COLUMN IF EXISTS "revoked_at",
         DROP COLUMN IF EXISTS "status",
         DROP COLUMN IF EXISTS "batch_id"`,
    );
    await q.query(`DROP TABLE IF EXISTS "code_batches"`);
    await q.query(`DROP TYPE IF EXISTS "attendance_code_audit_action_enum"`);
    await q.query(`DROP TYPE IF EXISTS "attendance_code_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "code_batch_status_enum"`);
  }
}
