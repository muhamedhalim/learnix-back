import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes drift on `attendance_codes` — the largest gap found in this audit.
 *
 * `RenamePurchaseCodesToAttendanceCodes1768610000000` only renamed the
 * *table* (`purchase_codes` → `attendance_codes`) and its indexes/FK
 * constraint names; it never touched columns. So `attendance_codes` still
 * has `InitialSchema1734986400000`'s original 2015-era `purchase_codes`
 * shape: `code_type` (varchar), separate nullable `lesson_id`/`package_id`,
 * `used_by_id`. `AddIsActiveToAttendanceCodes1768619000000` and
 * `AddCodeBatchManagement1768660000000` later added `is_active`,
 * `batch_id`, and `status` correctly — only the *original* columns were
 * never brought forward to match `AttendanceCode`'s current polymorphic
 * `type`/`item_id` model.
 *
 * `code_type`→`type` is a rename + enum conversion. `lesson_id`+`package_id`
 * collapse into one polymorphic `item_id`, selected by the (now-converted)
 * `type`: this is exactly what `code_type`'s value already recorded per
 * row, not an inference. `used_by_id`→`used_by` is a straight rename.
 * `created_by` has no equivalent in the old schema (attendance codes were
 * never attributed to their creator before); left to fail loudly on
 * `SET NOT NULL` if a real, unattributable row exists rather than guessing
 * an owner.
 */
export class FixAttendanceCodesSchema1820000006000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "code" TYPE character varying(16)`);

    await q.query(`ALTER TABLE "attendance_codes" RENAME COLUMN "code_type" TO "type"`);
    await q.query(`CREATE TYPE "attendance_codes_type_enum" AS ENUM ('lesson','package','book')`);
    await q.query(
      `ALTER TABLE "attendance_codes" ALTER COLUMN "type" TYPE "attendance_codes_type_enum" USING lower("type")::"attendance_codes_type_enum"`,
    );

    await q.query(`ALTER TABLE "attendance_codes" ADD COLUMN "item_id" uuid`);
    await q.query(`
      UPDATE "attendance_codes"
      SET "item_id" = CASE "type"
        WHEN 'lesson'  THEN "lesson_id"
        WHEN 'package' THEN "package_id"
        ELSE NULL
      END
    `);
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "item_id" SET NOT NULL`);

    await q.query(`ALTER TABLE "attendance_codes" RENAME COLUMN "used_by_id" TO "used_by"`);
    await q.query(
      `ALTER TABLE "attendance_codes" RENAME CONSTRAINT "FK_attendance_codes_used_by" TO "FK_attendance_codes_used_by_old"`,
    );

    await q.query(`ALTER TABLE "attendance_codes" ADD COLUMN "created_by" uuid`);
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "created_by" SET NOT NULL`);

    await q.query(
      `ALTER TABLE "attendance_codes" ALTER COLUMN "used_at" TYPE TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ALTER COLUMN "expires_at" TYPE TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(`UPDATE "attendance_codes" SET "expires_at" = now() + INTERVAL '1 year' WHERE "expires_at" IS NULL`);
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "expires_at" SET NOT NULL`);

    await q.query(`UPDATE "attendance_codes" SET "is_used" = false WHERE "is_used" IS NULL`);
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "is_used" SET NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "is_used" DROP NOT NULL`);
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "expires_at" DROP NOT NULL`);
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "expires_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "used_at" TYPE TIMESTAMP`);

    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN "created_by"`);

    await q.query(
      `ALTER TABLE "attendance_codes" RENAME CONSTRAINT "FK_attendance_codes_used_by_old" TO "FK_attendance_codes_used_by"`,
    );
    await q.query(`ALTER TABLE "attendance_codes" RENAME COLUMN "used_by" TO "used_by_id"`);

    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN "item_id"`);

    await q.query(
      `ALTER TABLE "attendance_codes" ALTER COLUMN "type" TYPE character varying USING "type"::text`,
    );
    await q.query(`DROP TYPE "attendance_codes_type_enum"`);
    await q.query(`ALTER TABLE "attendance_codes" RENAME COLUMN "type" TO "code_type"`);

    await q.query(`ALTER TABLE "attendance_codes" ALTER COLUMN "code" TYPE character varying`);
  }
}
