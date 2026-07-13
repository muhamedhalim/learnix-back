import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrects schema drift on `payments` that predates migration-based deploys.
 *
 * `InitialSchema1734986400000` created `payments` with `student_id`,
 * `currency`, a free-text `status`/`payment_method`, and `transaction_id`.
 * The `Payment` entity was since redesigned around a generic
 * user/item-purchase model (`user_id`, `item_type`, `item_id`,
 * `discount_amount`, `final_amount`, `paymob_transaction_id`,
 * `idempotency_key`, `failure_reason`, enum-typed `status`/`payment_method`)
 * — but no migration ever applied that redesign to the table. Every
 * environment that "worked" did so because TypeORM's `synchronize` (dev-only;
 * production throws if enabled) silently rebuilt the table to match the
 * entity. Any environment relying solely on migrations — including
 * production, since migrations never actually executed there until the
 * runner's file-discovery glob was fixed — was left with the original
 * `student_id`-shaped table, which is why
 * `AddOpenPaymentUniqueGuard1768680000000` (the first migration to actually
 * query `payments.user_id`) fails with "column does not exist".
 *
 * This migration performs the missing transformation directly against
 * whatever `InitialSchema` produced — not by inventing a plausible schema,
 * but by renaming/adding exactly the columns the current `Payment` entity
 * declares. It preserves existing rows: `student_id` is renamed (not
 * dropped+recreated), and `item_type`/`item_id` — which have no equivalent
 * column in the old schema — are derived from the purchase-link tables
 * (`lesson_purchases`, `package_purchases`, `book_purchases`) that already
 * reference `payments.id`, since that is the only place this information
 * exists for a pre-existing row. `currency`, `transaction_id`, and
 * `metadata` are left in place (unmapped by the entity but harmless) rather
 * than dropped, since dropping them cannot be undone and isn't required to
 * fix the reported failure.
 */
export class FixPaymentsUserIdColumn1768675000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- user_id (rename, preserves data + the existing FK) ---------------
    await q.query(`ALTER TABLE "payments" RENAME COLUMN "student_id" TO "user_id"`);
    await q.query(
      `ALTER TABLE "payments" RENAME CONSTRAINT "FK_payments_student" TO "FK_payments_user"`,
    );
    await q.query(`ALTER INDEX "IDX_payments_student_id" RENAME TO "IDX_payments_user_id"`);

    // ---- item_type (derived from the purchase-link tables) ----------------
    await q.query(`CREATE TYPE "payments_item_type_enum" AS ENUM ('lesson', 'package', 'book')`);
    await q.query(`ALTER TABLE "payments" ADD COLUMN "item_type" "payments_item_type_enum"`);
    await q.query(`
      UPDATE "payments" p SET "item_type" = 'lesson'
      WHERE EXISTS (SELECT 1 FROM "lesson_purchases" lp WHERE lp."payment_id" = p."id")
    `);
    await q.query(`
      UPDATE "payments" p SET "item_type" = 'package'
      WHERE p."item_type" IS NULL
        AND EXISTS (SELECT 1 FROM "package_purchases" pp WHERE pp."payment_id" = p."id")
    `);
    await q.query(`
      UPDATE "payments" p SET "item_type" = 'book'
      WHERE p."item_type" IS NULL
        AND EXISTS (SELECT 1 FROM "book_purchases" bp WHERE bp."payment_id" = p."id")
    `);
    // Any row still NULL here is a payment attempt with no linked purchase
    // (e.g. abandoned before completion) — the old schema recorded nothing
    // that identifies what it was for, so there is no correct value to
    // derive. Fail loudly rather than guess; if this ever fires, that
    // specific row needs a manual decision, not a silent default.
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "item_type" SET NOT NULL`);

    // ---- item_id (same derivation, keyed by the resolved item_type) -------
    await q.query(`ALTER TABLE "payments" ADD COLUMN "item_id" uuid`);
    await q.query(`
      UPDATE "payments" p SET "item_id" = lp."lesson_id"
      FROM "lesson_purchases" lp
      WHERE lp."payment_id" = p."id" AND p."item_type" = 'lesson'
    `);
    await q.query(`
      UPDATE "payments" p SET "item_id" = pp."package_id"
      FROM "package_purchases" pp
      WHERE pp."payment_id" = p."id" AND p."item_type" = 'package'
    `);
    await q.query(`
      UPDATE "payments" p SET "item_id" = bp."book_id"
      FROM "book_purchases" bp
      WHERE bp."payment_id" = p."id" AND p."item_type" = 'book'
    `);
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "item_id" SET NOT NULL`);

    // ---- discount_amount / final_amount ------------------------------------
    await q.query(
      `ALTER TABLE "payments" ADD COLUMN "discount_amount" numeric(10,2) NOT NULL DEFAULT 0`,
    );
    await q.query(`ALTER TABLE "payments" ADD COLUMN "final_amount" numeric(10,2)`);
    await q.query(`UPDATE "payments" SET "final_amount" = "amount" - "discount_amount"`);
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "final_amount" SET NOT NULL`);

    // ---- status / payment_method: free-text -> the entity's enum types ----
    // Existing values are lower-cased before the cast: the app only ever
    // wrote the TypeScript enums' (lowercase) string values through
    // TypeORM — the only way an uppercase value could appear is via the old
    // column's own DEFAULT 'PENDING', which lower() normalises safely. Any
    // value that still doesn't match a label fails the cast explicitly
    // instead of being coerced into an arbitrary bucket.
    await q.query(
      `CREATE TYPE "payments_status_enum" AS ENUM ('pending','processing','completed','failed','refunded','expired')`,
    );
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT`);
    await q.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE "payments_status_enum" USING lower("status")::"payments_status_enum"`,
    );
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending'`);

    await q.query(
      `CREATE TYPE "payments_payment_method_enum" AS ENUM ('card','wallet','purchase_code')`,
    );
    await q.query(
      `ALTER TABLE "payments" ALTER COLUMN "payment_method" TYPE "payments_payment_method_enum" USING lower("payment_method")::"payments_payment_method_enum"`,
    );
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "payment_method" SET DEFAULT 'card'`);

    // ---- paymob_transaction_id (carries forward the old transaction_id) ---
    await q.query(
      `ALTER TABLE "payments" ADD COLUMN "paymob_transaction_id" character varying(255)`,
    );
    await q.query(
      `UPDATE "payments" SET "paymob_transaction_id" = "transaction_id" WHERE "transaction_id" IS NOT NULL`,
    );

    // ---- paymob_order_id: widen to match the entity's varchar(255) --------
    await q.query(
      `ALTER TABLE "payments" ALTER COLUMN "paymob_order_id" TYPE character varying(255)`,
    );

    // ---- idempotency_key ----------------------------------------------------
    // No equivalent existed before; legacy rows get a deterministic,
    // guaranteed-unique placeholder derived from their own id rather than a
    // fabricated business value.
    await q.query(`ALTER TABLE "payments" ADD COLUMN "idempotency_key" character varying(255)`);
    await q.query(`UPDATE "payments" SET "idempotency_key" = 'legacy-' || "id"::text`);
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "idempotency_key" SET NOT NULL`);
    await q.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "UQ_payments_idempotency_key" UNIQUE ("idempotency_key")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "IDX_payments_idempotency_key" ON "payments" ("idempotency_key")`,
    );

    // ---- failure_reason -----------------------------------------------------
    await q.query(`ALTER TABLE "payments" ADD COLUMN "failure_reason" text`);

    // ---- remaining indexes the entity declares -----------------------------
    // "IDX_payments_status" already exists from InitialSchema and survives
    // the status column's type change unmodified.
    await q.query(`CREATE INDEX "IDX_payments_item_type" ON "payments" ("item_type")`);
    await q.query(`CREATE INDEX "IDX_payments_created_at" ON "payments" ("created_at")`);
    await q.query(`CREATE INDEX "IDX_payments_user_status" ON "payments" ("user_id", "status")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_payments_user_status"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_payments_created_at"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_payments_item_type"`);

    await q.query(`ALTER TABLE "payments" DROP COLUMN "failure_reason"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_payments_idempotency_key"`);
    await q.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "UQ_payments_idempotency_key"`,
    );
    await q.query(`ALTER TABLE "payments" DROP COLUMN "idempotency_key"`);

    await q.query(`ALTER TABLE "payments" ALTER COLUMN "paymob_order_id" TYPE character varying`);

    await q.query(`ALTER TABLE "payments" DROP COLUMN "paymob_transaction_id"`);

    await q.query(`ALTER TABLE "payments" ALTER COLUMN "payment_method" DROP DEFAULT`);
    await q.query(
      `ALTER TABLE "payments" ALTER COLUMN "payment_method" TYPE character varying USING "payment_method"::text`,
    );
    await q.query(`DROP TYPE "payments_payment_method_enum"`);

    await q.query(`ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT`);
    await q.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE character varying USING "status"::text`,
    );
    await q.query(`ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'PENDING'`);
    await q.query(`DROP TYPE "payments_status_enum"`);

    await q.query(`ALTER TABLE "payments" ALTER COLUMN "final_amount" DROP NOT NULL`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN "final_amount"`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN "discount_amount"`);

    await q.query(`ALTER TABLE "payments" ALTER COLUMN "item_id" DROP NOT NULL`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN "item_id"`);

    await q.query(`ALTER TABLE "payments" ALTER COLUMN "item_type" DROP NOT NULL`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN "item_type"`);
    await q.query(`DROP TYPE "payments_item_type_enum"`);

    await q.query(`ALTER INDEX "IDX_payments_user_id" RENAME TO "IDX_payments_student_id"`);
    await q.query(
      `ALTER TABLE "payments" RENAME CONSTRAINT "FK_payments_user" TO "FK_payments_student"`,
    );
    await q.query(`ALTER TABLE "payments" RENAME COLUMN "user_id" TO "student_id"`);
  }
}
