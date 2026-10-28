import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The marketplace finance permissions (spec §V). Kept literal on purpose: a migration must keep doing
 * what it did when it was written, whatever `FINANCE_PERMISSIONS` later becomes.
 */
const MARKETPLACE_FINANCE_PERMISSIONS = JSON.stringify([
  'marketplace.reports.view',
  'marketplace.reports.export',
  'marketplace.refunds.view',
  'marketplace.refunds.process',
  'marketplace.payouts.view',
  'marketplace.payouts.approve',
  'marketplace.payouts.pay',
  'marketplace.commission.manage',
  'marketplace.ledger.adjust',
]);

/**
 * `GrantAdminFinancePermissions2058` gave every administrator a fixed list and `users.finance_permissions`
 * has defaulted to `[]` ever since, so an administrator created before the marketplace existed holds none
 * of the `marketplace.*` permissions. Every finance-gated marketplace page (ledger, commission, sales,
 * exports, payouts, refunds, course removal) then answers 403, and nothing in the product can grant them.
 *
 * Migration 2058's rule applies unchanged: finance permissions are capabilities of the one `admin` role,
 * not a second role. This adds the marketplace set to administrators, keeps whatever else each already
 * holds, and does nothing to anyone else. Idempotent: an administrator who already has all of them is not
 * touched.
 */
export class GrantAdminMarketplaceFinancePermissions2211000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "users"
          SET "finance_permissions" = (
            SELECT COALESCE(jsonb_agg(DISTINCT "permission" ORDER BY "permission"), '[]'::jsonb)
              FROM jsonb_array_elements_text("users"."finance_permissions" || '${MARKETPLACE_FINANCE_PERMISSIONS}'::jsonb) AS "held"("permission")
          )
        WHERE "role" = 'admin'
          AND NOT ("finance_permissions" @> '${MARKETPLACE_FINANCE_PERMISSIONS}'::jsonb)`,
    );
  }

  public async down(): Promise<void> {
    // Permission history is security-sensitive (as in 2058): a rollback cannot tell these grants from
    // ones an operator made by hand afterwards, so it must not silently remove a valid capability.
  }
}
