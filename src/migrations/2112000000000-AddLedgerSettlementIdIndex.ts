import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `financial_ledger_entries.settlement_id` lookup / FK index (spec 004 T078, G-023, C-003).
 *
 * Settlement reads (`payment-operations`, `settlements.service`) and the
 * `FK_ledger_settlement ... ON DELETE RESTRICT` check filter on `settlement_id`, which no index
 * led with. Partial: most ledger rows are not settled, so the index stays small. The matching
 * entity `@Index` carries the identical name, column and `where`. CONCURRENTLY, hence
 * `transaction = false`.
 */
export class AddLedgerSettlementIdIndex2112000000000 implements MigrationInterface {
  public name = 'AddLedgerSettlementIdIndex2112000000000';

  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_ledger_settlement_id" ON "financial_ledger_entries" ("settlement_id") WHERE "settlement_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_ledger_settlement_id"`);
  }
}
