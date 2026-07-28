import { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenDiscountCodeControls2040000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discount_codes" ADD COLUMN IF NOT EXISTS "max_uses_per_user" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "discount_codes" ADD COLUMN IF NOT EXISTS "max_discount_amount" numeric(10,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "discount_codes" ALTER COLUMN "valid_until" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "discount_code_usage" DROP CONSTRAINT IF EXISTS "UQ_discount_code_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "discount_code_usage" ADD CONSTRAINT "UQ_discount_code_payment" UNIQUE ("discount_code_id", "payment_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_discount_usage_code_user" ON "discount_code_usage" ("discount_code_id", "user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discount_code_usage" DROP CONSTRAINT IF EXISTS "UQ_discount_code_payment"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_discount_usage_code_user"`);
    await queryRunner.query(
      `ALTER TABLE "discount_codes" DROP COLUMN IF EXISTS "max_discount_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "discount_codes" DROP COLUMN IF EXISTS "max_uses_per_user"`,
    );
  }
}
