import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Export & printing system + batch-timeline audit events (additive).
 *
 * - `code_exports`: asynchronous export/print jobs (CSV/Excel/PDF/JSON/QR) with
 *   status, progress, cached-file metadata and TTL for cleanup.
 * - Extends `attendance_code_audit_action_enum` with batch/export lifecycle
 *   events used by the per-batch activity timeline.
 *
 * Backward compatible: nothing is dropped or renamed.
 */
export class AddCodeExportsAndTimeline1768670000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- new audit-action values (timeline) --------------------------------
    // ADD VALUE is safe inside a transaction on PG 12+ as long as the value is
    // not used in the same transaction (we only create a table below).
    for (const value of [
      'batch_created',
      'batch_started',
      'batch_failed',
      'export_requested',
      'downloaded',
    ]) {
      await q.query(
        `ALTER TYPE "attendance_code_audit_action_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    // ---- export enums ------------------------------------------------------
    await q.query(
      `CREATE TYPE "code_export_format_enum" AS ENUM ('csv','excel','pdf','json','qr')`,
    );
    await q.query(
      `CREATE TYPE "code_export_pdf_layout_enum" AS ENUM ('a4_grid','labels','cards','qr_sheet')`,
    );
    await q.query(
      `CREATE TYPE "code_export_status_enum" AS ENUM ('pending','processing','completed','failed')`,
    );

    // ---- code_exports ------------------------------------------------------
    await q.query(
      `CREATE TABLE "code_exports" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "format" "code_export_format_enum" NOT NULL,
         "layout" "code_export_pdf_layout_enum",
         "status" "code_export_status_enum" NOT NULL DEFAULT 'pending',
         "progress" integer NOT NULL DEFAULT 0,
         "filters" jsonb,
         "batch_id" uuid,
         "total_count" integer,
         "file_name" character varying(255),
         "file_path" text,
         "file_size" bigint,
         "error_message" text,
         "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
         "created_by" uuid NOT NULL,
         "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_code_exports" PRIMARY KEY ("id")
       )`,
    );

    await q.query(`CREATE INDEX "IDX_code_exports_created_by" ON "code_exports" ("created_by")`);
    await q.query(`CREATE INDEX "IDX_code_exports_status" ON "code_exports" ("status")`);
    await q.query(`CREATE INDEX "IDX_code_exports_batch_id" ON "code_exports" ("batch_id")`);
    await q.query(`CREATE INDEX "IDX_code_exports_expires_at" ON "code_exports" ("expires_at")`);

    await q.query(
      `ALTER TABLE "code_exports"
         ADD CONSTRAINT "FK_code_exports_created_by"
         FOREIGN KEY ("created_by") REFERENCES "users"("id")
         ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "code_exports" DROP CONSTRAINT IF EXISTS "FK_code_exports_created_by"`,
    );
    await q.query(`DROP TABLE IF EXISTS "code_exports"`);
    await q.query(`DROP TYPE IF EXISTS "code_export_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "code_export_pdf_layout_enum"`);
    await q.query(`DROP TYPE IF EXISTS "code_export_format_enum"`);
    // Note: Postgres cannot remove individual enum values; the added
    // audit-action values are intentionally retained on rollback.
  }
}
