import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A cart has one gateway charge but retains one normal Order per product.
 * The aggregate checkout never replaces an Order: it only owns the external
 * charge that is allocated to child product payments after verification.
 */
export class AddCartCheckoutAggregation2075000000000 implements MigrationInterface {
  public name = 'AddCartCheckoutAggregation2075000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cart_checkouts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "checkout_number" varchar(40) NOT NULL,
        "student_id" uuid NOT NULL,
        "cart_id" uuid NOT NULL,
        "payment_id" uuid,
        "cart_fingerprint" varchar(64) NOT NULL,
        "original_amount_minor" bigint NOT NULL,
        "discount_amount_minor" bigint NOT NULL DEFAULT 0,
        "final_amount_minor" bigint NOT NULL,
        "currency" char(3) NOT NULL DEFAULT 'EGP',
        "status" varchar(40) NOT NULL DEFAULT 'awaiting_payment',
        "payment_method" varchar(30) NOT NULL,
        "discount_code_id" uuid,
        "cart_snapshot" jsonb NOT NULL,
        "idempotency_key" varchar(255) NOT NULL,
        "failure_reason" text,
        "expires_at" timestamptz,
        "paid_at" timestamptz,
        "cancelled_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cart_checkouts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cart_checkouts_student" FOREIGN KEY ("student_id")
          REFERENCES "users"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cart_checkouts_number" ON "cart_checkouts" ("checkout_number")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cart_checkouts_idempotency" ON "cart_checkouts" ("idempotency_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cart_checkouts_student_status" ON "cart_checkouts" ("student_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cart_checkouts_expiry" ON "cart_checkouts" ("status", "expires_at")`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cart_checkouts_open_cart"
      ON "cart_checkouts" ("student_id", "cart_fingerprint")
      WHERE "status" IN ('awaiting_payment', 'payment_processing')
    `);

    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cart_checkout_id" uuid`);
    await queryRunner.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "cart_checkout_id" uuid`);
    await queryRunner.query(`ALTER TABLE "payments" ALTER COLUMN "item_type" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "payments" ALTER COLUMN "item_id" DROP NOT NULL`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_orders_cart_checkout'
        ) THEN
          ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_cart_checkout"
          FOREIGN KEY ("cart_checkout_id") REFERENCES "cart_checkouts"("id") ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_payments_cart_checkout'
        ) THEN
          ALTER TABLE "payments" ADD CONSTRAINT "FK_payments_cart_checkout"
          FOREIGN KEY ("cart_checkout_id") REFERENCES "cart_checkouts"("id") ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_cart_checkout" ON "orders" ("cart_checkout_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_cart_checkout" ON "payments" ("cart_checkout_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A cart checkout is an audit/financial record. Refuse a destructive
    // rollback once it has been used instead of silently losing traceability.
    const used = await queryRunner.query(`SELECT 1 FROM "cart_checkouts" LIMIT 1`);
    if (used.length > 0) {
      throw new Error('Cannot revert cart checkout aggregation after checkout records exist');
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payments_cart_checkout"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_cart_checkout"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "FK_payments_cart_checkout"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_orders_cart_checkout"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "cart_checkout_id"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "cart_checkout_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cart_checkouts"`);
  }
}
