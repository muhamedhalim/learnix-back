import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-114/FR-140/FR-169 (T112) — "no financial trace" for a zero-value
 * (free) order is already structurally enforced for the ledger by
 * `CHK_mp_ledger_amount_positive` (`amount_minor > 0`, the original
 * `2096000000000-CreateMarketplaceMoney` migration), but
 * `marketplace_instructor_earnings` had no equivalent: `CHK_mp_earnings_split`
 * only requires `commission_amount_minor + net_amount_minor =
 * gross_amount_minor`, which a `0 + 0 = 0` row satisfies. This closes that
 * gap the same way — a database-level backstop for the "no earning" half
 * of the rule, independent of whether every future caller of
 * `settle()`/`LedgerService.createEarning()` remembers the `is_zero_value`
 * guard.
 */
export class AddEarningsAmountPositiveConstraint2104000000000 implements MigrationInterface {
  public name = 'AddEarningsAmountPositiveConstraint2104000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_instructor_earnings"
        ADD CONSTRAINT "CHK_mp_earnings_amount_positive" CHECK ("gross_amount_minor" > 0);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_instructor_earnings"
        DROP CONSTRAINT IF EXISTS "CHK_mp_earnings_amount_positive";
    `);
  }
}
