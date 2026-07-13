import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the drift on `discount_codes` and `discount_code_usage` found by
 * comparing the full migration chain against the current entities.
 *
 * `discount_codes`: `discount_type` was never converted from `varchar` to
 * `DiscountType`'s enum (verified live — still `varchar`, not a naming false
 * positive). `applicable_to` was `varchar`; the entity's `simple-array`
 * column type stores as `text` — a lossless widening. `item_ids`,
 * `description` have no old equivalent (added nullable). `valid_from`/
 * `valid_until` replace the old `expires_at`: `valid_until` is a direct
 * semantic match; `valid_from` has no prior column, so it's backfilled from
 * `created_at` (a code was always valid from when it was created).
 * `expires_at` is left in place, unmapped — the same zero-data-loss policy
 * used for `payments.currency`/etc.
 *
 * `discount_code_usage`: `student_id`→`user_id` and `created_at`→`used_at`
 * are true renames (`RenameColumn`, not drop+add) — same underlying data,
 * matching `DiscountCodeUsage`'s `user_id`/`used_at`.
 */
export class FixDiscountCodesSchema1820000002000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "code" TYPE character varying(50)`);

    await q.query(`CREATE TYPE "discount_codes_discount_type_enum" AS ENUM ('percentage','fixed')`);
    await q.query(
      `ALTER TABLE "discount_codes" ALTER COLUMN "discount_type" TYPE "discount_codes_discount_type_enum" USING lower("discount_type")::"discount_codes_discount_type_enum"`,
    );

    await q.query(
      `ALTER TABLE "discount_codes" ALTER COLUMN "applicable_to" TYPE text`,
    );

    await q.query(`ALTER TABLE "discount_codes" ADD COLUMN "item_ids" jsonb`);
    await q.query(
      `ALTER TABLE "discount_codes" ADD COLUMN "description" character varying(255)`,
    );

    await q.query(`ALTER TABLE "discount_codes" ADD COLUMN "valid_from" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "discount_codes" ADD COLUMN "valid_until" TIMESTAMP WITH TIME ZONE`);
    await q.query(`UPDATE "discount_codes" SET "valid_from" = "created_at"`);
    await q.query(`UPDATE "discount_codes" SET "valid_until" = "expires_at" WHERE "expires_at" IS NOT NULL`);
    // A pre-existing row with a NULL expires_at was never time-limited —
    // treat it as valid indefinitely rather than guessing an end date.
    await q.query(`UPDATE "discount_codes" SET "valid_until" = "created_at" + INTERVAL '100 years' WHERE "valid_until" IS NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "valid_from" SET NOT NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "valid_until" SET NOT NULL`);

    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "max_uses" SET DEFAULT 1`);
    await q.query(`UPDATE "discount_codes" SET "max_uses" = 1 WHERE "max_uses" IS NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "max_uses" SET NOT NULL`);

    await q.query(`UPDATE "discount_codes" SET "used_count" = 0 WHERE "used_count" IS NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "used_count" SET NOT NULL`);

    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "min_purchase_amount" SET DEFAULT 0`);
    await q.query(`UPDATE "discount_codes" SET "min_purchase_amount" = 0 WHERE "min_purchase_amount" IS NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "min_purchase_amount" SET NOT NULL`);

    await q.query(`UPDATE "discount_codes" SET "is_active" = true WHERE "is_active" IS NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "is_active" SET NOT NULL`);

    // ---- discount_code_usage: true renames, data preserved -----------------
    await q.query(`ALTER TABLE "discount_code_usage" RENAME COLUMN "student_id" TO "user_id"`);
    await q.query(
      `ALTER TABLE "discount_code_usage" RENAME CONSTRAINT "FK_discount_code_usage_student" TO "FK_discount_code_usage_user"`,
    );
    await q.query(`ALTER TABLE "discount_code_usage" RENAME COLUMN "created_at" TO "used_at"`);

    // `DiscountCodeUsage` declares @Unique('UQ_discount_code_user', ['discount_code_id',
    // 'user_id']) — enforcing "one usage per user per code" — but InitialSchema never
    // added any uniqueness constraint on this table at all. Genuinely missing, not a
    // naming mismatch (confirmed: no UNIQUE constraint of any name existed before this).
    await q.query(
      `ALTER TABLE "discount_code_usage" ADD CONSTRAINT "UQ_discount_code_user" UNIQUE ("discount_code_id", "user_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "discount_code_usage" DROP CONSTRAINT "UQ_discount_code_user"`);

    await q.query(`ALTER TABLE "discount_code_usage" RENAME COLUMN "used_at" TO "created_at"`);
    await q.query(
      `ALTER TABLE "discount_code_usage" RENAME CONSTRAINT "FK_discount_code_usage_user" TO "FK_discount_code_usage_student"`,
    );
    await q.query(`ALTER TABLE "discount_code_usage" RENAME COLUMN "user_id" TO "student_id"`);

    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "is_active" DROP NOT NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "min_purchase_amount" DROP NOT NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "min_purchase_amount" DROP DEFAULT`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "used_count" DROP NOT NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "max_uses" DROP NOT NULL`);
    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "max_uses" DROP DEFAULT`);

    await q.query(`ALTER TABLE "discount_codes" DROP COLUMN "valid_until"`);
    await q.query(`ALTER TABLE "discount_codes" DROP COLUMN "valid_from"`);
    await q.query(`ALTER TABLE "discount_codes" DROP COLUMN "description"`);
    await q.query(`ALTER TABLE "discount_codes" DROP COLUMN "item_ids"`);

    await q.query(
      `ALTER TABLE "discount_codes" ALTER COLUMN "applicable_to" TYPE character varying USING "applicable_to"::character varying`,
    );

    await q.query(
      `ALTER TABLE "discount_codes" ALTER COLUMN "discount_type" TYPE character varying USING "discount_type"::text`,
    );
    await q.query(`DROP TYPE "discount_codes_discount_type_enum"`);

    await q.query(`ALTER TABLE "discount_codes" ALTER COLUMN "code" TYPE character varying`);
  }
}
