import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A settlement may consume only part of a positive earning when prior refund
 * reversals leave a smaller net payable balance.  Store that allocation
 * explicitly instead of treating a whole earning row as irrevocably paid.
 */
export class AddSettlementEntryAllocation2052000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teacher_settlement_entries" ADD COLUMN IF NOT EXISTS "amount_minor" bigint`,
    );
    await queryRunner.query(`
      UPDATE "teacher_settlement_entries" membership
      SET "amount_minor" = ledger."amount_minor"
      FROM "financial_ledger_entries" ledger
      WHERE ledger."id" = membership."ledger_entry_id"
        AND membership."amount_minor" IS NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "teacher_settlement_entries" ALTER COLUMN "amount_minor" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "teacher_settlement_entries" DROP CONSTRAINT IF EXISTS "UQ_teacher_settlement_ledger_entry"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_teacher_settlement_entry_allocation" ON "teacher_settlement_entries" ("settlement_id", "ledger_entry_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_teacher_settlement_entry_allocation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teacher_settlement_entries" ADD CONSTRAINT "UQ_teacher_settlement_ledger_entry" UNIQUE ("ledger_entry_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "teacher_settlement_entries" DROP COLUMN IF EXISTS "amount_minor"`,
    );
  }
}
