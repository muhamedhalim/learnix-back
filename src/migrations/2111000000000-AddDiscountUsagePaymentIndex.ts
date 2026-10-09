import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `discount_code_usage.payment_id` lookup / FK index (spec 004 T078, G-023).
 *
 * The entity has declared `IDX_discount_usage_payment` for a long time, but no migration ever
 * created it, so outside the e2e `synchronize` schema the release path
 * (`DiscountCodesService.releaseUsageForPayment`, FK checks on `payments`) scanned the table.
 * Same name as the decorator so DDL and entity reconcile with no entity edit. CONCURRENTLY, hence
 * `transaction = false`; if an interrupted build leaves an INVALID index, drop it and re-run
 * (`SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`).
 */
export class AddDiscountUsagePaymentIndex2111000000000 implements MigrationInterface {
  public name = 'AddDiscountUsagePaymentIndex2111000000000';

  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_discount_usage_payment" ON "discount_code_usage" ("payment_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_discount_usage_payment"`);
  }
}
