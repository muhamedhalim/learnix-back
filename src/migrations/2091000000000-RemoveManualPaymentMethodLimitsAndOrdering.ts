import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the "display order", "order expiration", "minimum amount" and
 * "maximum amount" fields from manual payment methods. These were configurable
 * per method but are no longer part of the create/edit form; the business
 * logic that consumed them (list ordering, order-expiration window, and
 * amount-range eligibility) now uses fixed defaults instead.
 */
export class RemoveManualPaymentMethodLimitsAndOrdering2091000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_manual_payment_methods_enabled_order"`,
    );
    await queryRunner.query(
      `ALTER TABLE "manual_payment_methods" DROP CONSTRAINT IF EXISTS "CHK_manual_method_limits"`,
    );
    await queryRunner.query(
      `ALTER TABLE "manual_payment_methods"
         DROP COLUMN IF EXISTS "display_order",
         DROP COLUMN IF EXISTS "order_expiration_minutes",
         DROP COLUMN IF EXISTS "minimum_amount_minor",
         DROP COLUMN IF EXISTS "maximum_amount_minor"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_manual_payment_methods_enabled" ON "manual_payment_methods" ("enabled")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_manual_payment_methods_enabled"`);
    await queryRunner.query(
      `ALTER TABLE "manual_payment_methods"
         ADD COLUMN "display_order" integer NOT NULL DEFAULT 0,
         ADD COLUMN "order_expiration_minutes" integer NOT NULL DEFAULT 1440 CHECK ("order_expiration_minutes" BETWEEN 5 AND 43200),
         ADD COLUMN "minimum_amount_minor" bigint,
         ADD COLUMN "maximum_amount_minor" bigint`,
    );
    await queryRunner.query(
      `ALTER TABLE "manual_payment_methods" ADD CONSTRAINT "CHK_manual_method_limits" CHECK (
         ("minimum_amount_minor" IS NULL OR "minimum_amount_minor" >= 0)
         AND ("maximum_amount_minor" IS NULL OR "maximum_amount_minor" > 0)
         AND ("minimum_amount_minor" IS NULL OR "maximum_amount_minor" IS NULL OR "minimum_amount_minor" <= "maximum_amount_minor")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_manual_payment_methods_enabled_order" ON "manual_payment_methods" ("enabled","display_order")`,
    );
  }
}
