import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds provider-neutral reference columns to `payments` so a second gateway no
 * longer has to write into `paymob_*` columns.
 *
 * Historical rows are preserved untouched: the legacy `paymob_order_id` and
 * `paymob_transaction_id` columns stay in place (unmapped by the entity) and
 * their values are COPIED into the neutral columns. `provider` is not changed,
 * so Paymob history is never rewritten to look like another gateway's payment.
 * The previous application image keeps working against this schema, which
 * makes a rollback a plain image redeploy. A later migration may drop the
 * legacy columns once the release has been stable.
 */
export class NeutralizeGatewayReferenceColumns2207000000000 implements MigrationInterface {
  public name = 'NeutralizeGatewayReferenceColumns2207000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider_order_reference" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider_transaction_id" character varying(255)`,
    );
    await queryRunner.query(
      `UPDATE "payments" SET "provider_order_reference" = "paymob_order_id"
        WHERE "provider_order_reference" IS NULL AND "paymob_order_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE "payments" SET "provider_transaction_id" = "paymob_transaction_id"
        WHERE "provider_transaction_id" IS NULL AND "paymob_transaction_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_provider_order_reference"
         ON "payments" ("provider", "provider_order_reference")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Non-destructive on purpose (F-33): the neutral provider_* columns hold the ONLY copy of every
    // non-Paymob payment's references, so dropping them would destroy EasyKash references. Reverting
    // therefore drops just the index; the columns stay and are simply unused by the older code.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payments_provider_order_reference"`);
  }
}
