import { MigrationInterface, QueryRunner } from 'typeorm';

const DEFAULT_FINANCE_PERMISSIONS = JSON.stringify([
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  'settlements.create',
  'settlements.view',
  'settlements.approve',
  'settlements.pay',
  'settlements.reject',
  'settlements.cancel',
  'reconciliation.run',
  'reconciliation.review',
]);

/**
 * Adds the new permissions to the database default only. Existing permission
 * assignments are intentionally retained unchanged, preserving least privilege
 * until an administrator explicitly grants reject/cancel access.
 */
export class AddSettlementTerminalPermissions2055000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '${DEFAULT_FINANCE_PERMISSIONS}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '["refunds.create","refunds.process","refunds.complete","settlements.create","settlements.approve","settlements.pay","reconciliation.run","reconciliation.review"]'::jsonb`,
    );
  }
}
