import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes drift on `package_purchases` and `lesson_purchases`: both entities
 * gained `price_paid` with no equivalent column in `InitialSchema`. Each row
 * already has a `payment_id` FK, so `price_paid` is backfilled from the
 * linked `payments.final_amount` — a real derivation from existing
 * relational structure, not a guess. `purchased_at`/`access_granted_at`
 * (no prior column) default to the purchase row's own `created_at`.
 * `access_expires_at`/`created_at`/`updated_at` are widened from
 * `TIMESTAMP` to `TIMESTAMPTZ` to match `timestamptz`-typed entity columns.
 */
export class FixPurchaseTablesColumns1820000005000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- package_purchases --------------------------------------------------
    await q.query(`ALTER TABLE "package_purchases" ADD COLUMN "price_paid" numeric(10,2)`);
    await q.query(`
      UPDATE "package_purchases" pp
      SET "price_paid" = COALESCE((SELECT p."final_amount" FROM "payments" p WHERE p."id" = pp."payment_id"), 0)
    `);
    await q.query(`ALTER TABLE "package_purchases" ALTER COLUMN "price_paid" SET NOT NULL`);

    await q.query(`ALTER TABLE "package_purchases" ADD COLUMN "purchased_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`UPDATE "package_purchases" SET "purchased_at" = "created_at"`);
    await q.query(`ALTER TABLE "package_purchases" ALTER COLUMN "purchased_at" SET NOT NULL`);

    await q.query(
      `ALTER TABLE "package_purchases" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`,
    );

    // ---- lesson_purchases ----------------------------------------------------
    await q.query(`ALTER TABLE "lesson_purchases" ADD COLUMN "price_paid" numeric(10,2)`);
    await q.query(`
      UPDATE "lesson_purchases" lp
      SET "price_paid" = COALESCE((SELECT p."final_amount" FROM "payments" p WHERE p."id" = lp."payment_id"), 0)
    `);
    await q.query(`ALTER TABLE "lesson_purchases" ALTER COLUMN "price_paid" SET NOT NULL`);

    await q.query(`ALTER TABLE "lesson_purchases" ADD COLUMN "access_granted_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`UPDATE "lesson_purchases" SET "access_granted_at" = "created_at"`);
    await q.query(`ALTER TABLE "lesson_purchases" ALTER COLUMN "access_granted_at" SET NOT NULL`);

    await q.query(
      `ALTER TABLE "lesson_purchases" ADD COLUMN "days_extended" integer NOT NULL DEFAULT 0`,
    );

    await q.query(
      `ALTER TABLE "lesson_purchases" ADD COLUMN "updated_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(`UPDATE "lesson_purchases" SET "updated_at" = "created_at"`);
    await q.query(`ALTER TABLE "lesson_purchases" ALTER COLUMN "updated_at" SET NOT NULL`);
    await q.query(`ALTER TABLE "lesson_purchases" ALTER COLUMN "updated_at" SET DEFAULT now()`);

    await q.query(
      `ALTER TABLE "lesson_purchases" ALTER COLUMN "access_expires_at" TYPE TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "lesson_purchases" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lesson_purchases" ALTER COLUMN "created_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "lesson_purchases" ALTER COLUMN "access_expires_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "lesson_purchases" DROP COLUMN "updated_at"`);
    await q.query(`ALTER TABLE "lesson_purchases" DROP COLUMN "days_extended"`);
    await q.query(`ALTER TABLE "lesson_purchases" DROP COLUMN "access_granted_at"`);
    await q.query(`ALTER TABLE "lesson_purchases" DROP COLUMN "price_paid"`);

    await q.query(`ALTER TABLE "package_purchases" ALTER COLUMN "created_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "package_purchases" DROP COLUMN "purchased_at"`);
    await q.query(`ALTER TABLE "package_purchases" DROP COLUMN "price_paid"`);
  }
}
